import {
  Directive,
  ElementRef,
  booleanAttribute,
  effect,
  inject,
  input,
  model,
} from '@angular/core';

// Thousands-grouped numeric input. Turns a plain `type="text"
// inputmode="numeric"` <input> into a money field that shows id-ID grouping
// (e.g. 1.750.000) while emitting a clean numeric model. IDR has no fractional
// unit, so only the integer part is kept (see user locale). Pair with
// `(appThousandsChange)` or read the two-way `appThousands` model.
@Directive({
  selector: 'input[appThousands]',
  standalone: true,
  host: { '(input)': 'onInput()' },
})
export class ThousandsInputDirective {
  private readonly host = inject<ElementRef<HTMLInputElement>>(ElementRef);

  // Two-way numeric value. null = empty field.
  readonly appThousands = model<number | null>(null);
  // Allow a leading minus (credit-card balances are stored negative).
  readonly allowNegative = input(false, { transform: booleanAttribute });

  private readonly fmt = new Intl.NumberFormat('id-ID', {
    maximumFractionDigits: 0,
  });

  constructor() {
    // Reflect programmatic value changes (edit prefill, computed totals) into
    // the field. Guarded so it never fights the user's in-progress typing.
    effect(() => {
      const formatted = this.format(this.appThousands());
      const el = this.host.nativeElement;
      if (el.value !== formatted) el.value = formatted;
    });
  }

  onInput(): void {
    const el = this.host.nativeElement;
    const raw = el.value;
    const caret = el.selectionStart ?? raw.length;
    const negative = this.allowNegative() && raw.trim().startsWith('-');
    const digitsLeft = (raw.slice(0, caret).match(/\d/g) ?? []).length;
    const digits = raw.replace(/\D/g, '');

    const num = digits === '' ? null : Number(digits) * (negative ? -1 : 1);
    // Keep a lone '-' visible so a negative value can still be typed.
    const formatted =
      digits === '' ? (negative ? '-' : '') : this.format(num);

    el.value = formatted;
    const pos = this.caretFor(formatted, digitsLeft, negative);
    el.setSelectionRange(pos, pos);
    this.appThousands.set(num);
  }

  private format(value: number | null): string {
    return value == null || Number.isNaN(value) ? '' : this.fmt.format(value);
  }

  // Place the caret just after the Nth grouped digit so editing mid-string
  // doesn't jump to the end on every keystroke.
  private caretFor(
    formatted: string,
    digitsLeft: number,
    negative: boolean,
  ): number {
    if (digitsLeft === 0) return negative ? 1 : 0;
    let seen = 0;
    for (let i = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) {
        seen++;
        if (seen >= digitsLeft) return i + 1;
      }
    }
    return formatted.length;
  }
}
