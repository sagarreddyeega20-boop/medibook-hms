/** Shapes returned by /api/pharmacy. */
export type StockLevel = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

export interface StockMedicine {
  id: string;
  code: string;
  name: string;
  genericName: string | null;
  form: string | null;
  strength: string | null;
  sellingPricePaise: number;
  purchasePricePaise: number;
  marginPaise: number;
  stockQuantity: number;
  reorderLevel: number;
  isActive: boolean;
  level: StockLevel;
}

export interface DispenseItem {
  id: string;
  medicineName: string;
  dose: string | null;
  frequency: string | null;
  durationDays: number | null;
  route: string | null;
  instructions: string | null;
  quantity: number;
  dispensedQuantity: number;
  remaining: number;
  medicine: { id: string; code: string; name: string; strength: string | null; form: string | null; stockQuantity: number; sellingPricePaise: number; level: StockLevel } | null;
}

export interface DispenseView {
  prescription: { id: string; orderNumber: string | null; status: string; createdAt: string };
  patient: { id: string; name: string; mrn: string; gender: string; age: number | null } | null;
  doctor: { name: string; department: string | null };
  items: DispenseItem[];
}

/** "1 tablet · 1-0-1 · 5 days · After food" */
export const directions = (i: Pick<DispenseItem, 'dose' | 'frequency' | 'durationDays' | 'route' | 'instructions'>) =>
  [i.dose, i.frequency, i.durationDays ? `${i.durationDays} days` : null, i.route, i.instructions].filter(Boolean).join(' · ');

/** The most that can be given now: what is left on the prescription, capped by stock. */
export const maxNow = (i: DispenseItem) => (i.medicine ? Math.max(0, Math.min(i.remaining, i.medicine.stockQuantity)) : 0);
