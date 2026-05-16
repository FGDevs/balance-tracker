import { Component, computed, input } from '@angular/core';
import { CurrencyFormatPipe } from '../../pipes/currency-format.pipe';

@Component({
  selector: 'app-amount-display',
  standalone: true,
  imports: [CurrencyFormatPipe],
  templateUrl: './amount-display.component.html',
})
export class AmountDisplayComponent {
  readonly actual = input.required<number>();
  readonly available = input.required<number>();
  readonly currency = input<string>('IDR');

  readonly hasReservation = computed(() => this.actual() !== this.available());
}
