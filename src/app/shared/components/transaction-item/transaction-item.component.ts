import { Component, input, output } from '@angular/core';
import { IonItem, IonLabel, IonNote } from '@ionic/angular/standalone';
import { Transaction } from '../../../core/models';
import { CurrencyFormatPipe } from '../../pipes/currency-format.pipe';

@Component({
  selector: 'app-transaction-item',
  standalone: true,
  imports: [IonItem, IonLabel, IonNote, CurrencyFormatPipe],
  template: `
    <ion-item button (click)="itemClick.emit(transaction().id)">
      <ion-label>
        <h3>{{ transaction().category?.name ?? 'Uncategorized' }}</h3>
        <p class="text-xs">{{ transaction().note }}</p>
      </ion-label>
      <ion-note slot="end">
        {{ transaction().amount | currencyFormat }}
      </ion-note>
    </ion-item>
  `,
})
export class TransactionItemComponent {
  readonly transaction = input.required<Transaction>();
  readonly itemClick = output<number>();
}
