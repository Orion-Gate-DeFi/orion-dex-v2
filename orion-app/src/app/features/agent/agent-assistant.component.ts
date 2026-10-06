/**
 * Orion Assistant — launcher (EAGER, intentionally tiny).
 *
 * Variant A "docked assistant": a persistent "✦ Ask" button that lives in the
 * app shell and overlays any screen. This is the ONLY agent code in the eager
 * bundle — the panel, AgentService and transports load on first open via the
 * `@defer` block below, so the assistant adds ~nothing to first paint and never
 * loads for a user who doesn't open it.
 *
 * Modern-Angular note: the agent is a self-contained standalone feature with a
 * lazy boundary (@defer), NOT an @NgModule (the app is standalone-only). The
 * defer block is the "module" boundary.
 *
 * @author Orion DEX Team
 * @version 0.3.0 — launcher + lazy panel (@defer)
 */
import { Component, signal } from '@angular/core';
import { AgentPanelComponent } from './agent-panel.component';

@Component({
  selector: 'app-agent-assistant',
  standalone: true,
  // AgentPanelComponent is referenced ONLY inside the @defer block, so Angular
  // code-splits it (and everything it imports) into a lazy chunk.
  imports: [AgentPanelComponent],
  template: `
    @if (!isOpen()) {
      <button
        type="button"
        class="agent-fab"
        (click)="open()"
        aria-label="Open Orion Assistant"
      >
        <span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
        <span class="agent-fab-label">Ask</span>
      </button>
    }

    <!-- Loaded once, on first open; toggled with @if thereafter (no reload). -->
    @defer (when hasOpened()) {
      @if (isOpen()) {
        <app-agent-panel (closed)="close()" />
      }
    }
  `,
  styles: [`
    :host { display: contents; }

    .agent-fab {
      position: fixed;
      right: 20px;
      bottom: calc(40px + env(safe-area-inset-bottom, 0px));
      z-index: var(--z-sticky);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 48px;
      padding: 0 18px 0 16px;
      border: none;
      border-radius: var(--orion-radius-chip);
      background: var(--orion-accent);
      color: #fff;
      font: 600 14px/1 var(--orion-font-display);
      cursor: pointer;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.38);
      transition: background 160ms ease, transform 120ms ease;

      .material-symbols-outlined { font-size: 20px; }
      &:hover { background: var(--orion-accent-hover); }
      &:active { transform: scale(0.97); }
    }
    .agent-fab-label { white-space: nowrap; }
  `],
})
export class AgentAssistantComponent {
  protected readonly isOpen = signal(false);
  /** Latches true on first open so the @defer chunk loads once, then stays. */
  protected readonly hasOpened = signal(false);

  protected open(): void {
    this.hasOpened.set(true);
    this.isOpen.set(true);
  }

  protected close(): void {
    this.isOpen.set(false);
  }
}
