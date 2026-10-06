import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import type { ParamMap } from '@angular/router';
import { BuyComponent, RETURN_TO_APP_URL } from './buy.component';
import { WalletService } from '../../core/services/wallet.service';
import { ToastService } from '../../core/services/toast.service';

describe('BuyComponent', () => {
  let fixture: ComponentFixture<BuyComponent>;
  let component: BuyComponent;
  let mockWalletService: jasmine.SpyObj<WalletService>;
  let mockToastService: jasmine.SpyObj<ToastService>;

  /**
   * The component reads `?from=app` from the route SNAPSHOT, so the stub only
   * has to carry a queryParamMap — no observable plumbing needed.
   */
  const setup = async (
    queryParams: Record<string, string>,
    wallet: { connected: boolean; address: string | null },
  ): Promise<void> => {
    mockWalletService = jasmine.createSpyObj<WalletService>(
      'WalletService',
      ['connect', 'fundWallet'],
      {
        isConnected: signal<boolean | null>(wallet.connected).asReadonly(),
        address: signal<string | null>(wallet.address).asReadonly(),
      },
    );
    mockWalletService.connect.and.resolveTo(true);
    mockWalletService.fundWallet.and.resolveTo('confirmed');

    mockToastService = jasmine.createSpyObj<ToastService>('ToastService', [
      'error',
      'success',
      'info',
    ]);

    const snapshot: { queryParamMap: ParamMap } = { queryParamMap: convertToParamMap(queryParams) };

    await TestBed.configureTestingModule({
      imports: [BuyComponent],
      providers: [
        { provide: WalletService, useValue: mockWalletService },
        { provide: ToastService, useValue: mockToastService },
        { provide: ActivatedRoute, useValue: { snapshot } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BuyComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };

  const text = (): string => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const returnLink = (): HTMLAnchorElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector('a');
  /** The page heading also reads "Buy crypto" — match the CTA, not the text. */
  const buyButton = (): HTMLButtonElement | null =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
      .find(b => (b.textContent ?? '').includes('Buy crypto')) ?? null;

  const connectedWallet = { connected: true, address: '0x1111111111111111111111111111111111111111' };

  it('renders the login prompt while the wallet is disconnected', async () => {
    await setup({}, { connected: false, address: null });

    expect(component).toBeTruthy();
    expect(text()).toContain('Log in to continue');
    expect(buyButton()).toBeNull();
  });

  it('renders the buy action and the receiving address once connected', async () => {
    await setup({}, connectedWallet);

    expect(buyButton()).not.toBeNull();
    expect(text()).toContain(connectedWallet.address);
  });

  it('hides "Return to Orion" without ?from=app', async () => {
    await setup({}, connectedWallet);

    expect(text()).not.toContain('Return to Orion');
    expect(returnLink()).toBeNull();
  });

  it('shows "Return to Orion" deep link with ?from=app', async () => {
    await setup({ from: 'app' }, connectedWallet);

    expect(text()).toContain('Return to Orion');
    expect(returnLink()?.getAttribute('href')).toBe(RETURN_TO_APP_URL);
  });

  it('shows the deep link even before the wallet is connected', async () => {
    await setup({ from: 'app' }, { connected: false, address: null });

    expect(returnLink()?.getAttribute('href')).toBe(RETURN_TO_APP_URL);
  });

  it('ignores any other value of the from parameter', async () => {
    await setup({ from: 'newsletter' }, connectedWallet);

    expect(returnLink()).toBeNull();
  });

  it('passes the connected address to the funding flow', async () => {
    await setup({}, connectedWallet);

    await component.buyCrypto();

    expect(mockWalletService.fundWallet).toHaveBeenCalledWith(connectedWallet.address);
    expect(component.isFunding()).toBeFalse();
  });

  it('confirms a completed purchase with a success toast', async () => {
    await setup({}, connectedWallet);

    await component.buyCrypto();

    expect(mockToastService.success).toHaveBeenCalled();
    expect(mockToastService.info).not.toHaveBeenCalled();
    expect(mockToastService.error).not.toHaveBeenCalled();
  });

  // 'submitted' = paid at the provider, but the user left before Privy's
  // confirmation step. Pending, not failed — an info toast, never an error.
  it('reports a submitted purchase as still processing', async () => {
    await setup({}, connectedWallet);
    mockWalletService.fundWallet.and.resolveTo('submitted');

    await component.buyCrypto();

    expect(mockToastService.info).toHaveBeenCalled();
    expect(mockToastService.success).not.toHaveBeenCalled();
    expect(mockToastService.error).not.toHaveBeenCalled();
  });

  // Closing Privy's modal rejects the promise — that is a cancel, not a
  // failure, and must not raise any toast at all.
  for (const message of [
    'User exited flow',
    'Payment method selection was cancelled',
    'User cancelled funding',
  ]) {
    it(`stays silent when the user backs out ("${message}")`, async () => {
      await setup({}, connectedWallet);
      mockWalletService.fundWallet.and.rejectWith(new Error(message));

      await component.buyCrypto();

      expect(mockToastService.error).not.toHaveBeenCalled();
      expect(mockToastService.success).not.toHaveBeenCalled();
      expect(mockToastService.info).not.toHaveBeenCalled();
      expect(component.isFunding()).toBeFalse();
    });
  }

  it('surfaces a real funding failure as a toast', async () => {
    await setup({}, connectedWallet);
    mockWalletService.fundWallet.and.rejectWith(new Error('Unable to start payment session'));

    await component.buyCrypto();

    expect(mockToastService.error).toHaveBeenCalled();
    expect(mockToastService.success).not.toHaveBeenCalled();
    expect(component.isFunding()).toBeFalse();
  });
});
