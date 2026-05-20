import {
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { IonModal } from '@ionic/angular/standalone';

export interface SearchableSelectOption {
  id: number;
  label: string;
  sublabel?: string;
  hint?: string;
  disabled?: boolean;
}

@Component({
  selector: 'app-searchable-select',
  standalone: true,
  imports: [IonModal],
  templateUrl: './searchable-select.component.html',
})
export class SearchableSelectComponent {
  readonly options = input.required<SearchableSelectOption[]>();
  readonly value = input<number | null>(null);
  readonly valueChange = output<number | null>();
  readonly placeholder = input<string>('Pilih...');
  readonly searchPlaceholder = input<string>('Cari...');
  readonly modalTitle = input<string>('Pilih');
  readonly modalEyebrow = input<string>('Pilihan');
  readonly emptyMessage = input<string>('Tidak ditemukan.');
  readonly disabled = input<boolean>(false);
  readonly allowClear = input<boolean>(false);
  readonly compact = input<boolean>(false);

  readonly modalOpen = signal(false);
  readonly query = signal('');

  private readonly searchInput =
    viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly selectedOption = computed(() => {
    const v = this.value();
    if (v == null) return null;
    return this.options().find((o) => o.id === v) ?? null;
  });

  readonly filteredOptions = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.options();
    return this.options().filter((o) => {
      const hay = `${o.label} ${o.sublabel ?? ''} ${o.hint ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  });

  open(): void {
    if (this.disabled()) return;
    this.query.set('');
    this.modalOpen.set(true);
  }

  close(): void {
    this.modalOpen.set(false);
  }

  onPresented(): void {
    // Defer focus until after Ionic finishes the present animation.
    setTimeout(() => this.searchInput()?.nativeElement.focus(), 80);
  }

  select(option: SearchableSelectOption): void {
    if (option.disabled) return;
    this.valueChange.emit(option.id);
    this.close();
  }

  clear(): void {
    this.valueChange.emit(null);
    this.close();
  }

  onSearchInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
