// Supabase Edge Function — extract bank transactions from a screenshot via Gemini.
// Deploy: `supabase functions deploy extract-transactions`
// Secrets: `supabase secrets set GEMINI_API_KEY=... GEMINI_MODEL=gemini-2.5-flash`
// @ts-nocheck

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const DEFAULT_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = (model: string, key: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

interface Category {
  id: number;
  name: string;
  type: 'income' | 'expense' | 'transfer';
}

interface DraftOut {
  date: string;
  amount: number;
  type: 'income' | 'expense' | 'transfer';
  rawDescription: string;
  note: string;
  suggestedCategoryId?: number;
  transferDirection?: 'in' | 'out';
}

interface RequestBody {
  image?: string;
  accountId?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function errorResponse(
  code: 'quota_exceeded' | 'parse_failed' | 'unsupported_image' | 'unknown',
  status = 400,
): Response {
  return jsonResponse({ error: code }, status);
}

function buildPrompt(today: string, categories: Category[]): string {
  const incomeCats = categories.filter((c) => c.type === 'income');
  const expenseCats = categories.filter((c) => c.type === 'expense');
  const fmt = (c: Category) => `  ${c.id}: ${c.name}`;
  return [
    'Anda adalah pembaca screenshot aplikasi perbankan / dompet digital Indonesia (BCA, Mandiri, BRI, BNI, Jago, OVO, GoPay, dst).',
    `Hari ini adalah ${today} (ISO date). Setiap baris transaksi pada screenshot harus diekstrak menjadi satu objek.`,
    '',
    'ATURAN:',
    '- Tanggal: kembalikan dalam format YYYY-MM-DD. Resolusi "Hari ini" → hari ini, "Kemarin" → kemarin, dst.',
    '- Jumlah: angka positif (tanpa Rp atau pemisah ribuan).',
    '- Tipe:',
    '    - "transfer" jika baris adalah transfer antar bank/dompet (teks mengandung "Transfer", "TRF", "Kirim ke", "Terima dari", "Top up dari rekening", nama bank/dompet lain, dst).',
    '    - "income"   jika uang masuk ke akun pengguna dan bukan transfer.',
    '    - "expense"  jika uang keluar dari akun pengguna dan bukan transfer.',
    '- transferDirection (HANYA untuk type="transfer"):',
    '    - "out" jika uang KELUAR dari akun yang di-screenshot (debit/minus).',
    '    - "in"  jika uang MASUK ke akun yang di-screenshot (kredit/plus).',
    '    - Jangan isi field ini untuk type lain.',
    '- rawDescription: salin teks deskripsi/merchant verbatim dari screenshot.',
    '- note: bersihkan rawDescription menjadi catatan singkat yang mudah dibaca (contoh: "GOPAY/KOPI KENANGAN" → "Kopi Kenangan"; "TRF DR BCA 123" → "Transfer dari BCA"). Ini akan menjadi catatan transaksi yang disimpan; pengguna bisa mengeditnya.',
    '- suggestedCategoryId: pilih id kategori terbaik dari daftar di bawah; JANGAN isi untuk type="transfer". Jika tidak ada yang cocok, hilangkan field.',
    '- JANGAN buat id kategori baru. JANGAN sertakan saldo/total — hanya baris transaksi individual.',
    '- Lewati baris yang bukan transaksi (header, footer, "Saldo", "Total Mutasi", dll).',
    '',
    'Kategori pemasukan:',
    incomeCats.length ? incomeCats.map(fmt).join('\n') : '  (tidak ada)',
    '',
    'Kategori pengeluaran:',
    expenseCats.length ? expenseCats.map(fmt).join('\n') : '  (tidak ada)',
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    drafts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING' },
          amount: { type: 'NUMBER' },
          type: { type: 'STRING', enum: ['income', 'expense', 'transfer'] },
          rawDescription: { type: 'STRING' },
          note: { type: 'STRING' },
          suggestedCategoryId: { type: 'INTEGER', nullable: true },
          transferDirection: {
            type: 'STRING',
            enum: ['in', 'out'],
            nullable: true,
          },
        },
        required: ['date', 'amount', 'type', 'rawDescription', 'note'],
      },
    },
  },
  required: ['drafts'],
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return errorResponse('unknown', 405);
  }

  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiKey) {
    return errorResponse('unknown', 500);
  }
  const model = Deno.env.get('GEMINI_MODEL') ?? DEFAULT_MODEL;

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return errorResponse('unknown', 401);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('parse_failed');
  }
  if (!body.image || typeof body.accountId !== 'number') {
    return errorResponse('parse_failed');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnon) return errorResponse('unknown', 500);

  const supabase = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: categoryRows, error: catErr } = await supabase
    .from('categories')
    .select('id, name, type');
  if (catErr) return errorResponse('unknown', 500);
  const categories = (categoryRows ?? []) as Category[];

  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt(today, categories);

  let geminiResponse: Response;
  try {
    geminiResponse = await fetch(GEMINI_ENDPOINT(model, geminiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: 'image/jpeg', data: body.image } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.1,
        },
      }),
    });
  } catch {
    return errorResponse('unknown', 502);
  }

  if (geminiResponse.status === 429) return errorResponse('quota_exceeded', 429);
  if (geminiResponse.status === 400) {
    const text = await geminiResponse.text();
    if (/image|mime|inline_data/i.test(text)) {
      return errorResponse('unsupported_image');
    }
    return errorResponse('parse_failed');
  }
  if (!geminiResponse.ok) return errorResponse('unknown', 502);

  const geminiJson = await geminiResponse.json();
  const text: string | undefined =
    geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return errorResponse('parse_failed');

  let parsed: { drafts?: DraftOut[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return errorResponse('parse_failed');
  }

  const validIds = new Set(categories.map((c) => c.id));
  const drafts = (parsed.drafts ?? [])
    .filter(
      (d) =>
        typeof d?.date === 'string' &&
        typeof d?.amount === 'number' &&
        d.amount > 0 &&
        (d.type === 'income' || d.type === 'expense' || d.type === 'transfer'),
    )
    .map<DraftOut>((d) => {
      const isTransfer = d.type === 'transfer';
      return {
        date: d.date,
        amount: d.amount,
        type: d.type,
        rawDescription: d.rawDescription ?? '',
        note: d.note ?? d.rawDescription ?? '',
        suggestedCategoryId:
          !isTransfer &&
          d.suggestedCategoryId != null &&
          validIds.has(d.suggestedCategoryId)
            ? d.suggestedCategoryId
            : undefined,
        transferDirection: isTransfer
          ? d.transferDirection === 'in' || d.transferDirection === 'out'
            ? d.transferDirection
            : 'out'
          : undefined,
      };
    });

  return jsonResponse({ drafts });
});
