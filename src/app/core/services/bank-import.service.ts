import { Injectable, inject } from '@angular/core';
import { ImportDraft, Transaction } from '../models';
import { SupabaseService } from './supabase.service';
import { TransactionService } from './transaction.service';

const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.8;

export class BankImportError extends Error {
  constructor(
    message: string,
    readonly code: 'quota_exceeded' | 'parse_failed' | 'unsupported_image' | 'unknown',
  ) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class BankImportService {
  private supabase = inject(SupabaseService);
  private transactionService = inject(TransactionService);

  async extract(params: {
    imageBlob: Blob;
    accountId: number;
  }): Promise<ImportDraft[]> {
    const compressed = await this.compressImage(params.imageBlob);
    const base64 = await this.blobToBase64(compressed);

    const { data, error } = await this.supabase
      .getClient()
      .functions.invoke<{ drafts?: Omit<ImportDraft, 'skip'>[]; error?: string }>(
        'extract-transactions',
        {
          body: { image: base64, accountId: params.accountId },
        },
      );

    if (error) {
      throw new BankImportError(
        error.message ?? 'Gagal memanggil layanan ekstraksi',
        'unknown',
      );
    }
    if (!data || data.error) {
      const code = (data?.error ?? 'unknown') as BankImportError['code'];
      throw new BankImportError(this.messageForCode(code), code);
    }
    const drafts = data.drafts ?? [];
    return drafts.map<ImportDraft>((d) => ({ ...d, skip: false }));
  }

  async commit(params: {
    accountId: number;
    drafts: ImportDraft[];
  }): Promise<void> {
    const kept = params.drafts.filter((d) => !d.skip);
    // Assign explicit sort_index per draft so the screenshot's top→bottom order
    // maps to the list's top→bottom order within the date group. Anchor at Date.now()
    // so this batch sits above any pre-existing rows of the same date.
    const anchor = Date.now();
    for (let i = 0; i < kept.length; i++) {
      const draft = kept[i];
      const sortIndex = anchor - i;
      const note = draft.note?.trim() || draft.rawDescription || undefined;
      if (draft.type === 'transfer') {
        if (!draft.transferAccountId) {
          throw new Error('Transfer membutuhkan akun tujuan/asal');
        }
        const isOut = draft.transferDirection !== 'in';
        await this.transactionService.createTransfer({
          fromAccountId: isOut ? params.accountId : draft.transferAccountId,
          toAccountId: isOut ? draft.transferAccountId : params.accountId,
          amount: draft.amount,
          date: draft.date,
          note,
          sortIndex: sortIndex,
        });
      } else {
        await this.transactionService.create({
          account_id: params.accountId,
          category_id: draft.suggestedCategoryId,
          amount: draft.amount,
          type: draft.type,
          date: draft.date,
          note,
          sort_index: sortIndex,
        } as Omit<Transaction, 'id' | 'user_id' | 'created_at'>);
      }
    }
  }

  private messageForCode(code: BankImportError['code']): string {
    switch (code) {
      case 'quota_exceeded':
        return 'Kuota Gemini habis. Coba lagi nanti atau aktifkan billing.';
      case 'parse_failed':
        return 'Gagal membaca daftar transaksi dari gambar.';
      case 'unsupported_image':
        return 'Format gambar tidak didukung.';
      default:
        return 'Gagal mengimpor. Coba lagi.';
    }
  }

  private async compressImage(blob: Blob): Promise<Blob> {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();

      const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');
      ctx.drawImage(img, 0, 0, w, h);

      const out = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
      );
      if (!out) throw new Error('Gagal mengompres gambar');
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private async blobToBase64(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
}
