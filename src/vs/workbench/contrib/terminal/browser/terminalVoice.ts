/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { AccessibilityVoiceSettingId, SpeechTimeoutDefault } from 'vs/workbench/contrib/accessibility/browser/accessibilityConfiguration';
import { ISpeechService, ISpeechToTextEvent, SpeechToTextStatus } from 'vs/workbench/contrib/speech/common/speechService';
import { ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { isNumber } from 'vs/base/common/types';
import type { IDecoration } from '@xterm/xterm';
import { IXtermMarker } from 'vs/platform/terminal/common/capabilities/capabilities';
import { ThemeIcon } from 'vs/base/common/themables';
import { Codicon } from 'vs/base/common/codicons';
import { alert } from 'vs/base/browser/ui/aria/aria';
import { localize } from 'vs/nls';

const symbolMap: { [key: string]: string } = {
	'Ampersand': '&',
	'ampersand': '&',
	'Dollar': '$',
	'dollar': '$',
	'Percent': '%',
	'percent': '%',
	'Asterisk': '*',
	'asterisk': '*',
	'Plus': '+',
	'plus': '+',
	'Equals': '=',
	'equals': '=',
	'Exclamation': '!',
	'exclamation': '!',
	'Slash': '/',
	'slash': '/',
	'Backslash': '\\',
	'backslash': '\\',
	'Dot': '.',
	'dot': '.',
	'Period': '.',
	'period': '.',
	'Quote': '\'',
	'quote': '\'',
	'double quote': '"',
	'Double quote': '"',
};

export class TerminalVoiceSession extends Disposable {
	private _input: string = '';
	private _ghostText: IDecoration | undefined;
	private _ghostText2: IDecoration | undefined;
	private _decoration: IDecoration | undefined;
	private _marker: IXtermMarker | undefined;
	private _ghostTextMarker: IXtermMarker | undefined;
	private _ghostTextMarker2: IXtermMarker | undefined;
	private static _instance: TerminalVoiceSession | undefined = undefined;
	private _acceptTranscriptionScheduler: RunOnceScheduler | undefined;
	static getInstance(instantiationService: IInstantiationService): TerminalVoiceSession {
		if (!TerminalVoiceSession._instance) {
			TerminalVoiceSession._instance = instantiationService.createInstance(TerminalVoiceSession);
		}

		return TerminalVoiceSession._instance;
	}
	private _cancellationTokenSource: CancellationTokenSource | undefined;
	private readonly _disposables: DisposableStore;
	constructor(
		@ISpeechService private readonly _speechService: ISpeechService,
		@ITerminalService readonly _terminalService: ITerminalService,
		@IConfigurationService readonly configurationService: IConfigurationService,
		@IInstantiationService readonly _instantationService: IInstantiationService
	) {
		super();
		this._register(this._terminalService.onDidChangeActiveInstance(() => this.stop()));
		this._register(this._terminalService.onDidDisposeInstance(() => this.stop()));
		this._disposables = this._register(new DisposableStore());
	}

	start(chat?: boolean): void {
		this.stop();
		let voiceTimeout = this.configurationService.getValue<number>(AccessibilityVoiceSettingId.SpeechTimeout);
		if (!isNumber(voiceTimeout) || voiceTimeout < 0) {
			voiceTimeout = SpeechTimeoutDefault;
		}
		this._acceptTranscriptionScheduler = this._disposables.add(new RunOnceScheduler(() => {
			// this._sendText();
			this.stop(true);
		}, voiceTimeout));
		this._cancellationTokenSource = this._register(new CancellationTokenSource());
		const session = this._disposables.add(this._speechService.createSpeechToTextSession(this._cancellationTokenSource!.token));

		this._disposables.add(session.onDidChange((e) => {
			if (this._cancellationTokenSource?.token.isCancellationRequested) {
				return;
			}
			switch (e.status) {
				case SpeechToTextStatus.Started:
					// TODO: play start audio cue
					if (!this._decoration) {
						this._createDecoration();
					}
					break;
				case SpeechToTextStatus.Recognizing: {
					this._updateInput(e);
					this._renderGhostText(e);
					if (voiceTimeout > 0) {
						this._acceptTranscriptionScheduler!.cancel();
					}
					break;
				}
				case SpeechToTextStatus.Recognized:
					this._updateInput(e);
					if (chat) {
						this.stop(undefined, true);
					}
					if (voiceTimeout > 0) {
						this._acceptTranscriptionScheduler!.schedule();
					}
					break;
				case SpeechToTextStatus.Stopped:
					// TODO: play stop audio cue
					this.stop(undefined, chat);
					break;
			}
		}));
	}
	stop(send?: boolean, chat?: boolean): void {
		this._setInactive();
		if (send) {
			this._acceptTranscriptionScheduler!.cancel();
			this._sendText();
		}
		this._decoration?.dispose();
		this._decoration = undefined;
		if (!chat) {
			this._marker?.dispose();
			this._ghostTextMarker?.dispose();
			this._ghostText?.dispose();
			this._ghostText2?.dispose();
			this._ghostText = undefined;
			this._cancellationTokenSource?.cancel();
			this._disposables.clear();
			this._input = '';
		}
		if (chat) {
			this._createDecoration(chat);
			const demo = `#!/bin/bash\nfor i in {1..10}; do echo -n "$i "; done; echo`;
			this._renderGhostText(undefined, demo);
			setTimeout(() => {
				const demo = `#!/bin/bash\nfor i in {1..10}; do echo -n "$i "; done; echo`;
				this._ghostTextMarker2?.dispose();
				this._decoration?.dispose();
				this._ghostText2?.dispose();
				this._ghostText?.dispose();
				this._terminalService.activeInstance?.sendText(demo, false, true);
				this._terminalService.activeInstance?.xterm?.raw.markers.forEach(marker => {
					marker.dispose();
				});
				alert(localize('terminalVoiceTextInserted', '{0} inserted', demo));
			}, 2000);
		}
	}

	private _sendText(): void {
		const demo = `#!/bin/bash\nfor i in {1..10}; do echo -n "$i "; done; echo`;
		this._renderGhostText(undefined, demo);


	}

	private _updateInput(e: ISpeechToTextEvent): void {
		if (e.text) {
			let input = e.text.replaceAll(/[.,?;!]/g, '');
			for (const symbol of Object.entries(symbolMap)) {
				input = input.replace(new RegExp('\\b' + symbol[0] + '\\b'), symbol[1]);
			}
			this._input = ' ' + input;
		}
	}

	private _createDecoration(chat?: boolean): void {
		const activeInstance = this._terminalService.activeInstance;
		const xterm = activeInstance?.xterm?.raw;
		if (!xterm) {
			return;
		}
		const onFirstLine = xterm.buffer.active.cursorY === 0;
		this._marker = activeInstance.registerMarker(onFirstLine ? 0 : -1);
		if (!this._marker) {
			return;
		}
		this._decoration = xterm.registerDecoration({
			marker: this._marker,
			layer: 'top',
			x: xterm.buffer.active.cursorX ?? 0,
		});
		this._decoration?.onRender((e: HTMLElement) => {
			if (!chat) {
				e.classList.add(...ThemeIcon.asClassNameArray(Codicon.micFilled), 'terminal-voice', 'recording');
				e.style.transform = onFirstLine ? 'translate(10px, -2px)' : 'translate(-6px, -5px)';
			} else {
				e.classList.add('rectangle');
				e.textContent = localize('kbHints', 'Accept (Tab) Accept Word (Cmd+->)');
				e.style.transform = 'translate(-6px, -5px)';
				const hexColor = '#544B4B';
				e.style.backgroundColor = hexColor;
				e.style.width = '300px';
			}
		});
	}

	private _setInactive(): void {
		this._decoration?.element?.classList.remove('recording');
	}

	private _renderGhostText(e?: ISpeechToTextEvent, text?: string): void {
		this._ghostText?.dispose();
		this._ghostText2?.dispose();
		const textToRender = e?.text || text;
		if (!textToRender) {
			return;
		}
		const activeInstance = this._terminalService.activeInstance;
		const xterm = activeInstance?.xterm?.raw;
		if (!xterm) {
			return;
		}
		const onFirstLine = xterm.buffer.active.cursorY === 0;
		if (text) {
			this._ghostTextMarker2 = activeInstance.registerMarker();
			if (!this._ghostTextMarker2) {
				return;
			}
			this._ghostText2 = xterm.registerDecoration({
				marker: this._ghostTextMarker2,
				layer: 'top',
				x: onFirstLine ? xterm.buffer.active.cursorX + 4 : xterm.buffer.active.cursorX + 1 ?? 0,
			});
			this._ghostText2?.onRender((e: HTMLElement) => {
				e.classList.add('terminal-voice-progress-text');
				e.textContent = text;
				e.style.width = (xterm.cols - xterm.buffer.active.cursorX) / xterm.cols * 100 + '%';
				setTimeout(() => this._ghostText2?.dispose(), 2000);
			});
		} else {
			this._ghostTextMarker = activeInstance.registerMarker();
			if (!this._ghostTextMarker) {
				return;
			}
			this._ghostText = xterm.registerDecoration({
				marker: this._ghostTextMarker,
				layer: 'top',
				x: onFirstLine ? xterm.buffer.active.cursorX + 4 : xterm.buffer.active.cursorX + 1 ?? 0,
			});
			this._ghostText?.onRender((e: HTMLElement) => {
				e.classList.add('terminal-voice-progress-text');
				e.textContent = textToRender;
				e.style.width = (xterm.cols - xterm.buffer.active.cursorX) / xterm.cols * 100 + '%';
			});
		}

	}
}


