/*
 * This file is released under the MIT license.
 * Copyright (c) 2017, 2018, Mike Lischke
 *
 * See LICENSE file for more info.
 */

"use strict"

import {
    DebugSession, LoggingDebugSession, Handles, InitializedEvent, logger, Logger, Thread, Scope, Source, OutputEvent,
    TerminatedEvent, StoppedEvent, Breakpoint, BreakpointEvent, StackFrame
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol/lib/debugProtocol';

import { window, workspace, WorkspaceFolder, commands, Uri } from "vscode";
import * as fs from "fs-extra";
import * as path from "path";
const { Subject } = require('await-notify');

import { GrapsDebugger, GrapsBreakPoint } from '../backend/GrapsDebugger';
import { AntlrParseTreeProvider } from "./ParseTreeProvider";
import { AntlrFacade, ParseTreeNode, ParseTreeNodeType, LexerToken } from '../backend/facade';

/**
 * Interface that reflects the arguments as specified in package.json.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    input: string;
    startRule: string;
    grammar: string;
    stopOnEntry?: boolean;
    trace?: boolean;
    printParseTree?: boolean;
    visualParseTree?: boolean;
}

export interface DebuggerConsumer {
    debugger: GrapsDebugger;

    refresh(): void; // A full reload, e.g. after a grammar change.
    debuggerStopped(uri: Uri): void; // Called after each stop of the debugger (step, pause, breakpoint).
}

export class AntlrDebugSession extends LoggingDebugSession {
    /**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
    constructor(
        private folder: WorkspaceFolder,
        private backend: AntlrFacade,
        private consumers: DebuggerConsumer[]) {
        super("antlr4-vscode-trace.txt");

        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(false);

        this.parseTreeProvider = consumers[0] as AntlrParseTreeProvider;
    }

    shutdown(): void {
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments): void {

        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsStepInTargetsRequest = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments) {

        super.configurationDoneRequest(response, args);
        this.configurationDone.notify();
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
        logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        try {
            this.setup(args.grammar);
            for (let consumer of this.consumers) {
                consumer.debugger = this.debugger!;
                consumer.refresh();
            }
        } catch (e) {
            this.sendErrorResponse(response, { id: 1, format: "Could not prepare debug session:\n\n" + e });
            return;
        }

        // The launch request comes in before the breakpoints are set (which depends on the debugger
        // backend anyway). So we wait here for the configuration request end before we continue.
        await this.configurationDone.wait(1000);

        this.showTextualParseTree = args.printParseTree || false;
        this.showGraphicalParseTree = args.visualParseTree || false;
        this.testInput = args.input;

        try {
            let testInput = fs.readFileSync(args.input, { encoding: "utf8" });

            let startRuleIndex = this.debugger!.ruleIndexFromName(args.startRule);
            if (startRuleIndex < 0) {
                this.sendErrorResponse(response, {
                    id: 1,
                    format: "Error while launching debug session: start rule \"" + args.startRule + "\" not found"
                });
                return;
            }
            this.debugger!.start(startRuleIndex, testInput, args.noDebug ? true : false);
            if (this.showGraphicalParseTree) {
                this.parseTreeProvider.showWebview(Uri.file(args.grammar), { title: "Parse Tree: " + path.basename(args.grammar) });
            }

        } catch (e) {
            this.sendErrorResponse(response, { id: 1, format: "Could not launch debug session:\n\n" + e });
            return;
        }

        this.sendResponse(response);
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        this.debugger!.clearBreakPoints();
        if (args.breakpoints && args.source.path) {
            const actualBreakpoints = args.breakpoints.map(sourceBreakPoint => {
                let { validated, line, id } = this.debugger!.addBreakPoint(args.source.path!,
                    this.convertDebuggerLineToClient(sourceBreakPoint.line));
                const targetBreakPoint = <DebugProtocol.Breakpoint>new Breakpoint(validated,
                    this.convertClientLineToDebugger(line));
                targetBreakPoint.id = id;

                return targetBreakPoint;
            });

            response.body = {
                breakpoints: actualBreakpoints
            };
        }
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        // We have no threads, so return a dummy entry.
        response.body = {
            threads: [
                new Thread(AntlrDebugSession.THREAD_ID, "Interpreter")
            ]
        };
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;

        const stack = this.debugger!.currentStackTrace;
        let frames: StackFrame[] = [];
        for (let i = 0; i < stack.length; ++i) {
            let entry = stack[i];
            let frame: StackFrame;
            if (entry.next[0]) {
                frame = new StackFrame(i, entry.name,
                    this.createSource(entry.source),
                    this.convertDebuggerLineToClient(entry.next[0].start.row),
                    this.convertDebuggerColumnToClient(entry.next[0].start.column)
                );
            } else {
                frame = new StackFrame(i, entry.name + " <missing next>",
                    this.createSource(entry.source),
                    this.convertDebuggerLineToClient(1),
                    this.convertDebuggerColumnToClient(0)
                );
            }
            frames.push(frame);
        }
        response.body = {
            stackFrames: frames,
            totalFrames: stack.length
        };
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        // Cache a few values that stay the same during a single request for scopes and variables.
        this.tokens = this.debugger!.tokenList;
        this.variables = this.debugger!.getVariables(args.frameId);

		let scopes: Scope[] = [];
		scopes.push(new Scope("Globals", VarRef.Globals, true));
		//scopes.push(new Scope(this.debugger.getStackInfo(args.frameId), VarRef.Context, false));
        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        let variables: DebugProtocol.Variable[] = [];
        switch (args.variablesReference) {
            case VarRef.Globals: {
                variables.push({
                    name: "Test Input",
                    type: "string",
                    value: this.testInput,
                    variablesReference: 0
                });
                variables.push({
                    name: "Input Size",
                    type: "number",
                    value: this.debugger!.inputSize.toString(),
                    variablesReference: 0
                });
                variables.push({
                    name: "Error Count",
                    type: "number",
                    value: this.debugger!.errorCount.toString(),
                    variablesReference: 0
                });
                variables.push({
                    name: "Input Tokens",
                    value: (this.tokens.length - this.debugger!.currentTokenIndex).toString(),
                    variablesReference: VarRef.Tokens,
                    indexedVariables: this.tokens.length - this.debugger!.currentTokenIndex
                });
                break;
            }

            case VarRef.Context: { // Context related
                break;
            }

            case VarRef.Tokens: {
                let start =  this.debugger!.currentTokenIndex + (args.start ? args.start : 0);
                let length = args.count ? args.count : this.tokens.length;
                for (let i = 0; i < length; ++i) {
                    let index = start + i;
                    variables.push({
                        name: index + ": " + this.tokens[index].name,
                        type: "Token",
                        value: "",
                        variablesReference: VarRef.Token + index,
                        presentationHint: { kind: "class", attributes: ["readonly"] }
                    });
                }
                break;
            }

            default: {
                if (args.variablesReference >= VarRef.Token) {
                    let tokenIndex = args.variablesReference % VarRef.Token;
                    if (tokenIndex >= 0 && tokenIndex < this.tokens.length) {
                        let token = this.tokens[tokenIndex];
                        for (let property in token) {
                            variables.push({
                                name: property,
                                type: typeof token[property],
                                value: this.escapeText(token[property] + ""),
                                variablesReference: 0
                            });
                        }
                    }
                }
                break;
            }
        }

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this.debugger!.pause();
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this.debugger!.continue();
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this.debugger!.stepOver();
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this.debugger!.stepIn();
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this.debugger!.stepOut();
        this.sendResponse(response);
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        let reply: string | undefined = undefined;

        response.body = {
            result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
            variablesReference: 0
        };
        this.sendResponse(response);
    }

    private setup(grammar: string) {
        let basePath = path.dirname(grammar);
        this.debugger = this.backend.createDebugger(grammar, path.join(basePath, ".antlr"));
        if (!this.debugger) {
            throw Error("Debugger creation failed. There are grammar errors.");
        }

        if (!this.debugger.isValid) {
            throw Error("Debugger creation failed. You are either trying to debug an unsupported file type or " +
                "no interpreter data has been generated yet for the given grammar.");
        }

        this.debugger.on('stopOnStep', () => {
            this.notifyConsumers(Uri.file(grammar));
            this.sendEvent(new StoppedEvent('step', AntlrDebugSession.THREAD_ID));
        });

        this.debugger.on('stopOnPause', () => {
            this.notifyConsumers(Uri.file(grammar));
            this.sendEvent(new StoppedEvent('pause', AntlrDebugSession.THREAD_ID));
        });

        this.debugger.on('stopOnBreakpoint', () => {
            this.notifyConsumers(Uri.file(grammar));
            this.sendEvent(new StoppedEvent('breakpoint', AntlrDebugSession.THREAD_ID));
        });

        this.debugger.on('stopOnException', () => {
            this.notifyConsumers(Uri.file(grammar));
            this.sendEvent(new StoppedEvent('exception', AntlrDebugSession.THREAD_ID));
        });

        this.debugger.on('breakpointValidated', (bp: GrapsBreakPoint) => {
            this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.validated, id: bp.id }));
        });

        this.debugger.on('output', (text, filePath, line, column, isError) => {
            const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
            e.body.source = this.createSource(filePath);
            e.body.line = line;
            e.body.column = column;
            e.body.category = isError ? "stderr" : "stdout";
            this.sendEvent(e);
        });

        this.debugger.on('end', () => {
            this.notifyConsumers(Uri.file(grammar));
            if (this.showTextualParseTree) {
                let tree = this.debugger!.currentParseTree;
                if (tree) {
                    let text = this.parseNodeToString(tree);
                    this.sendEvent(new OutputEvent("Parse Tree:\n" + text + "\n"));
                } else {
                    this.sendEvent(new OutputEvent("No Parse Tree\n"));
                }
            }

            if (this.showGraphicalParseTree) {
                this.parseTreeProvider.showWebview(Uri.file(grammar), { title: "Parse Tree: " + path.basename(grammar) });
            }

            this.sendEvent(new TerminatedEvent());
        });
    }

    //---- helpers

    private createSource(filePath: string): Source {
        return new Source(path.basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'antlr-data');
    }

    private parseNodeToString(node: ParseTreeNode, level: number = 0): string {
        let result = " ".repeat(level);
        switch (node.type) {
            case ParseTreeNodeType.Rule: {
                let name = this.debugger!.ruleNameFromIndex(node.ruleIndex!);
                result += name ? name : "<unknown rule>";

                if (node.children.length > 0) {
                    result += " (\n";
                    for (let child of node.children) {
                        result += this.parseNodeToString(child, level + 1);
                    }
                    result += " ".repeat(level) + ")\n";
                }
                break;
            }

            case ParseTreeNodeType.Error: {
                result += " <Error>";
                if (node.symbol) {
                    result += "\"" + node.symbol.text + "\"\n";
                }
                break;
            }

            case ParseTreeNodeType.Terminal: {
                result += "\"" + node.symbol!.text + "\"\n";
                break;
            }

            default:
                break;
        }

        return result;
    }

    private notifyConsumers(uri: Uri) {
        for (let consumer of this.consumers) {
            consumer.debuggerStopped(uri);
        }
    }

    private escapeText(input: string): string {
        let result = "";
        for (let c of input) {
            switch (c) {
                case "\n": {
                    result += "\\n";
                    break;
                }

                case "\r": {
                    result += "\\r";
                    break;
                }

                case "\t": {
                    result += "\\t";
                    break;
                }

                default: {
                    result += c;
                    break;
                }
            }
        }
        return result;
    }

    private static THREAD_ID = 1;

    private debugger: GrapsDebugger | undefined;
    private parseTreeProvider: AntlrParseTreeProvider;
    private configurationDone = new Subject();

    private showTextualParseTree = false;
    private showGraphicalParseTree = false;
    private testInput = "";

    // Some variables, which are updated between each scope/var request.
    private tokens: LexerToken[];
    private variables: [string, string][];
}

enum VarRef {
    Globals = 1000,
    ParseTree = 1002,
    Context = 2000,
    Tokens = 3000,
    Token = 10000,
}
