import { Component, signal, WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { OrionSwapPillComponent, SUCCESS_AUTO_DISMISS_MS } from './active-swap-pill.component';
import { ActiveSwapHubService } from '../../../core/services/swap/active-swap-hub.service';
import type { ActiveSwapSummary } from '../../../core/services/swap/active-swap-hub.service';
import type { TransactionTrackingState } from '../../../core/models/swap.model';

@Component({ selector: 'app-dummy-route', standalone: true, template: '' })
class DummyRouteComponent {}

describe('OrionSwapPillComponent', () => {
  let fixture: ComponentFixture<OrionSwapPillComponent>;
  let activeSwap: WritableSignal<ActiveSwapSummary | null>;
  let trackingState: WritableSignal<TransactionTrackingState | null>;
  let dismissSpy: jasmine.Spy;
  let router: Router;

  const makeSummary = (overrides: Partial<ActiveSwapSummary> = {}): ActiveSwapSummary => ({
    txHash: '0xsrchash',
    fromChainId: 1,
    toChainId: 8453,
    fromSymbol: 'ETH',
    toSymbol: 'USDC',
    fromAmount: '1',
    toAmount: '2000',
    aggregator: 'squid',
    startedAt: Date.now(),
    phase: 'bridging',
    ...overrides,
  });

  beforeEach(async () => {
    activeSwap = signal<ActiveSwapSummary | null>(null);
    trackingState = signal<TransactionTrackingState | null>(null);
    dismissSpy = jasmine.createSpy('dismiss');

    await TestBed.configureTestingModule({
      imports: [OrionSwapPillComponent],
      providers: [
        provideRouter([
          { path: '', component: DummyRouteComponent },
          { path: 'swap', component: DummyRouteComponent },
          { path: 'send', component: DummyRouteComponent },
        ]),
        {
          provide: ActiveSwapHubService,
          // The pill only reads the two signals and calls dismiss().
          useValue: { activeSwap, trackingState, dismiss: dismissSpy },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(OrionSwapPillComponent);
    router = TestBed.inject(Router);
  });

  const pillEl = (): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector('.swap-pill');
  const cardEl = (): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector('.swap-pill-card');

  it('stays hidden while no swap is active', () => {
    fixture.detectChanges();
    expect(pillEl()).toBeNull();
    expect(cardEl()).toBeNull();
  });

  it('renders the collapsed chip with chain route + phase copy while bridging', () => {
    activeSwap.set(makeSummary());
    fixture.detectChanges();

    const pill = pillEl()!;
    expect(pill).not.toBeNull();
    expect(pill.textContent).toContain('ETH→BASE');
    expect(pill.textContent).toContain('Bridging');
    // Status changes are announced to screen readers.
    expect(pill.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(pill.classList).toContain('tone-live');
  });

  it('owns the bottom-LEFT corner — fixed position, left-anchored (agent FAB owns the right)', () => {
    activeSwap.set(makeSummary());
    fixture.detectChanges();

    const style = getComputedStyle(pillEl()!);
    expect(style.position).toBe('fixed');
    expect(style.left).toBe('20px');
    // Not right-anchored: `right` resolves from the viewport width, never 20px.
    expect(style.right).not.toBe('20px');
    expect(style.zIndex).toBe('40'); // var(--z-sticky)
  });

  it('hides on /swap (the status screen renders there) and reappears elsewhere', async () => {
    activeSwap.set(makeSummary());
    fixture.detectChanges();
    expect(pillEl()).not.toBeNull();

    await router.navigateByUrl('/swap');
    fixture.detectChanges();
    expect(pillEl()).toBeNull();

    await router.navigateByUrl('/send');
    fixture.detectChanges();
    expect(pillEl()).not.toBeNull();
  });

  it('terminal variants: success is ok-toned, failed danger-toned, untracked neutral with "Check explorer"', () => {
    activeSwap.set(makeSummary({ phase: 'success' }));
    fixture.detectChanges();
    expect(pillEl()!.classList).toContain('tone-ok');
    expect(pillEl()!.textContent).toContain('Swap complete ✓');

    activeSwap.set(makeSummary({ phase: 'failed' }));
    fixture.detectChanges();
    expect(pillEl()!.classList).toContain('tone-danger');
    expect(pillEl()!.textContent).toContain('Swap failed');

    activeSwap.set(makeSummary({ phase: 'untracked' }));
    fixture.detectChanges();
    expect(pillEl()!.classList).toContain('tone-neutral');
    expect(pillEl()!.textContent).toContain('Check explorer');
  });

  it('expands to the timeline card: amounts as-is, step dots, links, Open swap', () => {
    activeSwap.set(makeSummary({ trackingUrl: 'https://axelarscan.io/gmp/0xsrchash' }));
    trackingState.set({
      progress: 60,
      currentStep: 1,
      steps: [
        { id: 'source-confirm', title: 'Confirmed on Ethereum', status: 'completed', explorerLink: 'https://etherscan.io/tx/0xsrchash' },
        { id: 'bridging', title: 'Bridging tokens', status: 'in_progress' },
        { id: 'dest-confirm', title: 'Receiving on Base', status: 'pending' },
      ],
      isTracking: true,
    });
    fixture.detectChanges();

    pillEl()!.click();
    fixture.detectChanges();

    const card = cardEl()!;
    expect(card).not.toBeNull();
    expect(pillEl()).toBeNull();
    // Amounts come from the summary strings verbatim — never re-derived.
    expect(card.querySelector('.card-amounts')!.textContent).toContain('1 ETH');
    expect(card.querySelector('.card-amounts')!.textContent).toContain('2000 USDC');

    const steps = card.querySelectorAll('.card-step');
    expect(steps.length).toBe(3);
    expect(steps[0].querySelector('.step-dot')!.classList).toContain('step-completed');
    expect(steps[1].querySelector('.step-dot')!.classList).toContain('step-in_progress');
    expect(steps[0].querySelector('a.step-link')!.getAttribute('href')).toBe('https://etherscan.io/tx/0xsrchash');

    expect(card.querySelector('a.card-tracker')!.getAttribute('href')).toBe('https://axelarscan.io/gmp/0xsrchash');
    expect(card.querySelector('.card-open')!.textContent).toContain('Open swap');
  });

  it('Escape collapses the expanded card', () => {
    activeSwap.set(makeSummary());
    fixture.detectChanges();
    pillEl()!.click();
    fixture.detectChanges();
    expect(cardEl()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(cardEl()).toBeNull();
    expect(pillEl()).not.toBeNull();
  });

  it('Open swap navigates to /swap and the pill hides there', async () => {
    activeSwap.set(makeSummary());
    fixture.detectChanges();
    pillEl()!.click();
    fixture.detectChanges();

    (cardEl()!.querySelector('.card-open') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(router.url).toBe('/swap');
    expect(pillEl()).toBeNull();
    expect(cardEl()).toBeNull();
  });

  it('close on a LIVE swap only collapses — the hub keeps watching', () => {
    activeSwap.set(makeSummary());
    fixture.detectChanges();
    pillEl()!.click();
    fixture.detectChanges();

    (cardEl()!.querySelector('.card-close') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(dismissSpy).not.toHaveBeenCalled();
    expect(cardEl()).toBeNull();
    expect(pillEl()).not.toBeNull();
  });

  it('close on a settled swap dismisses the pill for good', () => {
    activeSwap.set(makeSummary({ phase: 'failed', errorMessage: 'Bridge failed' }));
    fixture.detectChanges();
    pillEl()!.click();
    fixture.detectChanges();

    (cardEl()!.querySelector('.card-close') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(dismissSpy).toHaveBeenCalled();
  });

  it('success auto-dismisses after 10 s', fakeAsync(() => {
    activeSwap.set(makeSummary());
    fixture.detectChanges();

    activeSwap.set(makeSummary({ phase: 'success' }));
    fixture.detectChanges();

    tick(SUCCESS_AUTO_DISMISS_MS - 1);
    expect(dismissSpy).not.toHaveBeenCalled();
    tick(1);
    expect(dismissSpy).toHaveBeenCalled();
  }));

  it('failed persists — no auto-dismiss timer runs', fakeAsync(() => {
    activeSwap.set(makeSummary({ phase: 'failed' }));
    fixture.detectChanges();

    tick(SUCCESS_AUTO_DISMISS_MS * 2);
    expect(dismissSpy).not.toHaveBeenCalled();
  }));

  it('a replacing swap cancels the success timer — it cannot dismiss the NEW pill', fakeAsync(() => {
    activeSwap.set(makeSummary({ phase: 'success' }));
    fixture.detectChanges();
    tick(SUCCESS_AUTO_DISMISS_MS / 2);

    // A new swap replaces the finished one before the timer fires.
    activeSwap.set(makeSummary({ txHash: '0xnew', phase: 'bridging' }));
    fixture.detectChanges();

    tick(SUCCESS_AUTO_DISMISS_MS * 2);
    expect(dismissSpy).not.toHaveBeenCalled();
  }));

  it('destroying the pill clears a pending auto-dismiss timer', fakeAsync(() => {
    activeSwap.set(makeSummary({ phase: 'success' }));
    fixture.detectChanges();

    // The component goes away before the timer fires (defensive: the mount
    // is app-lifetime today, but a dead component must not dismiss a pill).
    fixture.destroy();
    tick(SUCCESS_AUTO_DISMISS_MS * 2);

    expect(dismissSpy).not.toHaveBeenCalled();
  }));
});
