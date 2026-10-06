/**
 * Orion Assistant — the slide-over panel (LAZY).
 *
 * This is the heavy half of the agent (chat UI + AgentService + transports, and
 * later the tool layer + confirmation card). It is loaded on first open via an
 * `@defer` block in AgentAssistantComponent, so none of this — nor AgentService
 * and its transports — sits in the eager app-shell bundle.
 *
 * @author Orion DEX Team
 * @version 0.1.1 — Add AI disclosure copy: expand the empty-state note and keep
 *                  a persistent "AI-generated, not financial advice" small-print
 *                  line above the input in every state.
 */
import { Component, EventEmitter, OnDestroy, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentService } from '../../core/services/agent/agent.service';

@Component({
  selector: 'app-agent-panel',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="agent-backdrop" (click)="closed.emit()" aria-hidden="true"></div>
    <aside
      class="agent-panel orion-scale-in"
      role="dialog"
      aria-modal="true"
      aria-label="Orion Assistant"
      (keydown.escape)="closed.emit()"
    >
      <header class="agent-head">
        <div class="agent-head-title">
          <span class="material-symbols-outlined agent-head-glyph" aria-hidden="true">auto_awesome</span>
          <span>Orion Assistant</span>
          <span class="agent-beta">Beta</span>
        </div>
        <button type="button" class="agent-icon-btn" (click)="closed.emit()" aria-label="Close assistant">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </header>

      <div class="agent-body">
        @if (agent.messages().length === 0) {
          <div class="agent-empty">
            <span class="material-symbols-outlined agent-empty-glyph" aria-hidden="true">auto_awesome</span>
            <p class="agent-empty-title">How can I help?</p>
            <p class="agent-empty-sub">
              Ask about prices, your portfolio, or prepare a swap — you confirm
              every transaction. Answers are AI-generated and can be wrong;
              nothing here is financial advice.
            </p>
          </div>
        } @else {
          @for (m of agent.messages(); track $index) {
            <div class="agent-msg" [class.is-user]="m.role === 'user'">
              <div class="agent-bubble">
                @if (m.role === 'assistant' && m.content === '' && agent.isStreaming()) {
                  <span class="agent-thinking" role="status" aria-label="Assistant is thinking">
                    <span class="agent-dot"></span>
                    <span class="agent-dot"></span>
                    <span class="agent-dot"></span>
                  </span>
                } @else {
                  {{ m.content }}
                }
              </div>
            </div>
          }
        }
      </div>

      <div class="agent-input-wrap orion-agent-glow" [class.is-thinking]="agent.isStreaming()">
        <input
          class="agent-input"
          type="text"
          autocomplete="off"
          placeholder="Ask Orion…"
          aria-label="Message Orion Assistant"
          [ngModel]="draft()"
          (ngModelChange)="draft.set($event)"
          (keydown.enter)="send()"
        />
        <button
          type="button"
          class="agent-send"
          (click)="send()"
          [disabled]="!draft().trim() || agent.isStreaming()"
          aria-label="Send message"
        >
          <span class="material-symbols-outlined" aria-hidden="true">arrow_upward</span>
        </button>
      </div>

      <p class="agent-disclaimer">
        AI-generated and can be wrong — you confirm every transaction. Not financial advice.
      </p>
    </aside>
  `,
  styles: [`
    :host { display: contents; }

    .agent-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: var(--z-modal-backdrop);
      animation: agent-fade-in 160ms ease-out;
    }

    .agent-panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: var(--z-modal);
      width: min(400px, 100vw);
      display: flex;
      flex-direction: column;
      background: var(--orion-bg);
      border-left: 1px solid var(--orion-border);
      animation: agent-slide-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }

    @keyframes agent-slide-in {
      from { transform: translateX(24px); opacity: 0; }
      to   { transform: translateX(0); opacity: 1; }
    }
    @keyframes agent-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .agent-head {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 60px;
      padding: 0 12px 0 18px;
      border-bottom: 1px solid var(--orion-border);
    }
    .agent-head-title {
      display: flex;
      align-items: center;
      gap: 9px;
      font: 600 15px/1 var(--orion-font-display);
      color: var(--orion-text);
    }
    .agent-head-glyph { font-size: 18px; color: var(--orion-accent-text); }
    .agent-beta {
      font: 600 10px/1 var(--orion-font-display);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--orion-accent-text);
      background: var(--orion-accent-tint);
      padding: 3px 6px;
      border-radius: 6px;
    }
    .agent-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: none;
      background: transparent;
      color: var(--orion-muted);
      border-radius: 10px;
      cursor: pointer;

      &:hover { background: var(--orion-surface-2); color: var(--orion-text); }
      .material-symbols-outlined { font-size: 20px; }
    }

    .agent-body {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .agent-empty {
      margin: auto;
      max-width: 280px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
    }
    .agent-empty-glyph { font-size: 28px; color: var(--orion-accent-text); margin-bottom: 4px; }
    .agent-empty-title { font: 600 16px/1.2 var(--orion-font-display); color: var(--orion-text); }
    .agent-empty-sub { font-size: 13px; line-height: 1.5; color: var(--orion-muted); }

    .agent-msg { display: flex; }
    .agent-msg.is-user { justify-content: flex-end; }
    .agent-bubble {
      max-width: 84%;
      padding: 10px 13px;
      border-radius: 14px;
      font-size: 14px;
      line-height: 1.5;
      color: var(--orion-text);
      background: var(--orion-surface-2);
      border: 1px solid var(--orion-border);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .agent-msg.is-user .agent-bubble {
      background: var(--orion-accent-tint);
      border-color: transparent;
    }

    .agent-thinking { display: inline-flex; gap: 4px; align-items: center; }
    .agent-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--orion-accent-text);
      animation: agent-bounce 1.2s ease-in-out infinite;

      &:nth-child(2) { animation-delay: 0.15s; }
      &:nth-child(3) { animation-delay: 0.3s; }
    }
    @keyframes agent-bounce {
      0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
      40%           { opacity: 1; transform: translateY(-3px); }
    }

    .agent-input-wrap {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 12px;
      padding: 6px 6px 6px 14px;
      border-radius: var(--orion-radius-button);
      background: var(--orion-surface);
      border: 1px solid var(--orion-border);
    }
    .agent-input {
      flex: 1 1 auto;
      position: relative;
      z-index: 1;
      min-width: 0;
      border: none;
      background: transparent;
      outline: none;
      color: var(--orion-text);
      font: 400 16px/1.4 var(--orion-font-display);

      &::placeholder { color: var(--orion-subtle); }
    }
    .agent-send {
      flex: 0 0 auto;
      position: relative;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: none;
      border-radius: 10px;
      background: var(--orion-accent);
      color: #fff;
      cursor: pointer;
      transition: background 140ms ease, opacity 140ms ease;

      &:hover:not(:disabled) { background: var(--orion-accent-hover); }
      &:disabled { opacity: 0.4; cursor: default; }
      .material-symbols-outlined { font-size: 20px; }
    }

    .agent-disclaimer {
      flex: 0 0 auto;
      margin: -4px 16px 10px;
      font-size: 10px;
      line-height: 1.4;
      text-align: center;
      color: var(--orion-subtle);
    }

    @media (max-width: 540px) {
      .agent-panel { width: 100vw; border-left: none; }
    }
  `],
})
export class AgentPanelComponent implements OnDestroy {
  /** Emitted on backdrop click, the close button, or Escape. */
  @Output() readonly closed = new EventEmitter<void>();

  protected readonly agent = inject(AgentService);
  protected readonly draft = signal('');

  protected send(): void {
    const text = this.draft().trim();
    if (!text || this.agent.isStreaming()) return;
    this.draft.set('');
    void this.agent.send(text);
  }

  /**
   * Closing the panel (the parent's `@if` removes it) tears down any in-flight
   * turn, so a hung or late tool call can't keep spending backend AI budget or
   * navigate the user after they dismissed the assistant. The assistant never
   * moves funds (read-only tools) — this is reliability + UX hygiene.
   */
  ngOnDestroy(): void {
    this.agent.stop();
  }
}
