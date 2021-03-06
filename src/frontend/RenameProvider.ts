/*
 * This file is released under the MIT license.
 * Copyright (c) 2016, 2018, Mike Lischke
 *
 * See LICENSE file for more info.
 */

'use strict';

import { TextDocument, Position, CancellationToken, Range, Location, Uri, ProviderResult, WorkspaceEdit, RenameProvider } from 'vscode';
import * as path from "path";
import { AntlrFacade } from '../backend/facade';

export class AntlrRenameProvider implements RenameProvider {
    constructor(private backend: AntlrFacade) { }

    public provideRenameEdits(document: TextDocument, position: Position, newName: string,
        token: CancellationToken): ProviderResult<WorkspaceEdit> {
            let info = this.backend.symbolInfoAtPosition(document.fileName, position.character, position.line + 1, false);

            if (!info) {
                return undefined;
            }

            let result = new WorkspaceEdit();
            let occurences = this.backend.getSymbolOccurences(document.fileName, info.name);
            for (let symbol of occurences) {
                if (symbol.definition) {
                    let range = new Range(
                        symbol.definition.range.start.row - 1, symbol.definition.range.start.column,
                        symbol.definition.range.end.row - 1, symbol.definition.range.start.column + info.name.length
                    );
                    result.replace(Uri.file(symbol.source), range, newName);
                }
            }

            return result;
        }
};
