import { Component, input, output, signal } from '@angular/core';
import { IonModal } from '@ionic/angular/standalone';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { CalcPadComponent } from '../calc-pad/calc-pad.component';

// Calculator-icon suffix button for money inputs. Tap opens a sheet containing
// <app-calc-pad> seeded with the current value; the pad's "Gunakan" footer
// closes the sheet and emits the result. Designed to sit inside an input's
// right padding (absolute-positioned by the consumer) — see docs/ui-screens.md.
@Component({
  selector: 'app-calc-button',
  standalone: true,
  imports: [IonModal, CalcPadComponent],
  templateUrl: './calc-button.component.html',
})
export class CalcButtonComponent {
  readonly value = input<number | null>(null);
  readonly disabled = input(false);
  readonly allowNegative = input(false);
  readonly ariaLabel = input('Buka kalkulator');

  readonly result = output<number>();

  readonly isOpen = signal(false);
  // Captured at open-time so changes to `value` while the modal is open don't
  // re-seed the pad (which would feel like input loss to the user).
  readonly seedValue = signal<number | null>(null);

  async open(): Promise<void> {
    if (this.disabled()) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.seedValue.set(this.value());
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  onApply(value: number): void {
    this.result.emit(value);
    this.close();
  }
}
