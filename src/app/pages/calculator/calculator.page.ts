import { Component, inject } from '@angular/core';
import { Location } from '@angular/common';
import { IonContent } from '@ionic/angular/standalone';
import { CalcPadComponent } from '../../shared/components/calc-pad/calc-pad.component';

@Component({
  selector: 'app-calculator',
  standalone: true,
  imports: [IonContent, CalcPadComponent],
  templateUrl: './calculator.page.html',
})
export class CalculatorPage {
  private readonly location = inject(Location);

  goBack(): void {
    this.location.back();
  }
}
