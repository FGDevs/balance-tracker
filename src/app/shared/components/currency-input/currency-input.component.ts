import { Component, input, model } from '@angular/core';
import { IonInput } from '@ionic/angular/standalone';

@Component({
  selector: 'app-currency-input',
  standalone: true,
  imports: [IonInput],
  template: `
    <ion-input
      type="number"
      inputmode="decimal"
      [label]="label()"
      labelPlacement="stacked"
      [placeholder]="placeholder()"
      [(ngModel)]="value"
    />
  `,
})
export class CurrencyInputComponent {
  readonly value = model<number | null>(null);
  readonly label = input<string>('Amount');
  readonly placeholder = input<string>('0.00');
}
