import { TestBed } from '@angular/core/testing';
import { BalanceRefreshService } from './balance-refresh.service';

describe('BalanceRefreshService', () => {
  let service: BalanceRefreshService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [BalanceRefreshService]
    });
    service = TestBed.inject(BalanceRefreshService);
  });

  it('should emit multiple refresh events', (done) => {
    let count = 0;

    service.refresh$.subscribe(() => {
      count++;
      if (count === 3) {
        expect(count).toBe(3);
        done();
      }
    });

    service.triggerRefresh();
    service.triggerRefresh();
    service.triggerRefresh();
  });
});
