import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StatusIconComponent } from './status-icon.component';

describe('StatusIconComponent', () => {
  let fixture: ComponentFixture<StatusIconComponent>;
  let component: StatusIconComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [StatusIconComponent] }).compileComponents();
    fixture = TestBed.createComponent(StatusIconComponent);
    component = fixture.componentInstance;
  });

  const glyph = (): HTMLElement =>
    fixture.nativeElement.querySelector('.material-symbols-outlined') as HTMLElement;

  it('renders the glyph name inside a material-symbols span', () => {
    component.icon = 'check_circle';
    fixture.detectChanges();
    expect(glyph().textContent?.trim()).toBe('check_circle');
  });

  it('sizes the host circle from the size input', () => {
    component.size = 64;
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.style.width).toBe('64px');
    expect(host.style.height).toBe('64px');
  });

  it('maps the tint to the -tint background token and the solid glyph color', () => {
    component.tint = 'danger';
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.style.background).toContain('var(--orion-danger-tint)');
    expect(glyph().style.color).toContain('var(--orion-danger)');
  });

  // The button-safe accent fails contrast as a glyph on graphite — the
  // component must swap to the text-safe accent, not the solid token.
  it('uses the text-safe accent for accent glyphs', () => {
    component.tint = 'accent';
    fixture.detectChanges();
    expect(glyph().style.color).toContain('var(--orion-accent-text)');
    expect((fixture.nativeElement as HTMLElement).style.background).toContain('var(--orion-accent-tint)');
  });

  it('applies only the requested motion class', () => {
    component.animate = 'spin';
    fixture.detectChanges();
    expect(glyph().classList.contains('orion-spin')).toBeTrue();
    expect(glyph().classList.contains('animate-pulse')).toBeFalse();
  });

  it('stays static when animate is null', () => {
    fixture.detectChanges();
    expect(glyph().classList.contains('orion-spin')).toBeFalse();
    expect(glyph().classList.contains('animate-pulse')).toBeFalse();
  });
});
