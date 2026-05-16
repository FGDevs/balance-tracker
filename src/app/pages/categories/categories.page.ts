import { Component, computed, inject, signal } from '@angular/core';
import { Location, NgTemplateOutlet } from '@angular/common';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import {
  IonContent,
  IonModal,
  IonRefresher,
  IonRefresherContent,
  RefresherCustomEvent,
} from '@ionic/angular/standalone';
import { Category, CategoryType } from '../../core/models';
import { CategoryService } from '../../core/services/category.service';

const TYPE_ORDER: CategoryType[] = ['expense', 'income', 'transfer'];
const TYPE_LABEL: Record<CategoryType, string> = {
  expense: 'Pengeluaran',
  income: 'Pemasukan',
  transfer: 'Transfer',
};

const COLOR_PRESETS = [
  '#d97a3c',
  '#e9b067',
  '#3a6a9a',
  '#2f7a3d',
  '#b54a3c',
  '#6b4f3a',
];

const ICON_PRESETS = [
  'pricetag-outline',
  'cart-outline',
  'fast-food-outline',
  'cafe-outline',
  'home-outline',
  'cash-outline',
  'card-outline',
  'receipt-outline',
  'gift-outline',
  'medkit-outline',
  'fitness-outline',
  'school-outline',
  'briefcase-outline',
  'game-controller-outline',
  'heart-outline',
  'trending-up-outline',
];

interface TypeOption {
  value: CategoryType;
  label: string;
}

@Component({
  selector: 'app-categories',
  standalone: true,
  imports: [
    IonContent,
    IonModal,
    IonRefresher,
    IonRefresherContent,
    NgTemplateOutlet,
  ],
  templateUrl: './categories.page.html',
})
export class CategoriesPage {
  private categoryService = inject(CategoryService);
  private location = inject(Location);

  readonly colorPresets = COLOR_PRESETS;
  readonly iconPresets = ICON_PRESETS;
  readonly typeOptions: TypeOption[] = [
    { value: 'expense', label: 'Pengeluaran' },
    { value: 'income', label: 'Pemasukan' },
    { value: 'transfer', label: 'Transfer' },
  ];

  readonly categories = this.categoryService.categories;
  readonly loading = signal(false);

  readonly modalOpen = signal(false);
  readonly editingId = signal<number | null>(null);
  readonly name = signal('');
  readonly type = signal<CategoryType>('expense');
  readonly icon = signal<string>(ICON_PRESETS[0]);
  readonly color = signal<string>(COLOR_PRESETS[0]);

  readonly saving = signal(false);
  readonly deleting = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly confirmDelete = signal(false);

  readonly isEdit = computed(() => this.editingId() !== null);
  readonly typeLabel = computed(() => TYPE_LABEL[this.type()]);
  readonly canSubmit = computed(() => this.name().trim().length > 0);

  readonly grouped = computed(() => {
    const all = this.categories();
    return TYPE_ORDER.map((type) => ({
      type,
      label: TYPE_LABEL[type],
      items: all.filter((c) => c.type === type),
    })).filter((g) => g.items.length > 0);
  });

  constructor() {
    void this.refresh();
  }

  ionViewWillEnter(): void {
    void this.refresh();
  }

  asValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  goBack(): void {
    this.location.back();
  }

  private async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      await this.categoryService.loadCategories();
    } finally {
      this.loading.set(false);
    }
  }

  async onRefresh(event: RefresherCustomEvent): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    try {
      await this.categoryService.loadCategories();
    } finally {
      event.target.complete();
    }
  }

  async onAdd(): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light });
    this.editingId.set(null);
    this.name.set('');
    this.type.set('expense');
    this.icon.set(ICON_PRESETS[0]);
    this.color.set(COLOR_PRESETS[0]);
    this.errorMessage.set(null);
    this.confirmDelete.set(false);
    this.modalOpen.set(true);
  }

  async onItemClick(cat: Category): Promise<void> {
    if (cat.user_id === null) return;
    await Haptics.impact({ style: ImpactStyle.Light });
    this.editingId.set(cat.id);
    this.name.set(cat.name);
    this.type.set(cat.type);
    this.icon.set(cat.icon ?? ICON_PRESETS[0]);
    this.color.set(cat.color ?? COLOR_PRESETS[0]);
    this.errorMessage.set(null);
    this.confirmDelete.set(false);
    this.modalOpen.set(true);
  }

  closeModal(): void {
    if (this.saving() || this.deleting()) return;
    this.confirmDelete.set(false);
    this.modalOpen.set(false);
  }

  selectType(t: CategoryType): void {
    if (this.isEdit()) return;
    this.type.set(t);
  }

  selectIcon(name: string): void {
    this.icon.set(name);
    void Haptics.impact({ style: ImpactStyle.Light });
  }

  selectColor(c: string): void {
    this.color.set(c);
    void Haptics.impact({ style: ImpactStyle.Light });
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSubmit() || this.saving()) return;

    this.saving.set(true);
    this.errorMessage.set(null);
    await Haptics.impact({ style: ImpactStyle.Light });

    try {
      if (this.isEdit()) {
        await this.categoryService.update(this.editingId()!, {
          name: this.name().trim(),
          icon: this.icon(),
          color: this.color(),
        });
      } else {
        await this.categoryService.create({
          name: this.name().trim(),
          type: this.type(),
          icon: this.icon(),
          color: this.color(),
        });
      }

      await Haptics.notification({ type: NotificationType.Success });
      this.modalOpen.set(false);
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menyimpan',
      );
    } finally {
      this.saving.set(false);
    }
  }

  openConfirmDelete(): void {
    if (!this.isEdit() || this.deleting() || this.saving()) return;
    void Haptics.impact({ style: ImpactStyle.Medium });
    this.confirmDelete.set(true);
  }

  cancelConfirmDelete(): void {
    this.confirmDelete.set(false);
  }

  async onConfirmDelete(): Promise<void> {
    const id = this.editingId();
    if (id === null) return;

    this.deleting.set(true);
    this.errorMessage.set(null);
    this.confirmDelete.set(false);
    await Haptics.impact({ style: ImpactStyle.Medium });

    try {
      await this.categoryService.delete(id);
      await Haptics.notification({ type: NotificationType.Success });
      this.modalOpen.set(false);
    } catch (err) {
      await Haptics.notification({ type: NotificationType.Error });
      this.errorMessage.set(
        err instanceof Error ? err.message : 'Gagal menghapus',
      );
    } finally {
      this.deleting.set(false);
    }
  }
}
