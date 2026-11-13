/** Money is always integer paise. These helpers are the only place rupees appear. */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function formatPaise(paise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

export function assertPaise(value: number): number {
  if (!Number.isInteger(value)) throw new Error(`Money must be integer paise, got ${value}`);
  return value;
}
