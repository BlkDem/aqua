// Russian words that change with numbers.

/** plural(5, ['день', 'дня', 'дней']) -> 'дней' */
export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100, b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
}

export const count = (n, forms) => `${n} ${plural(n, forms)}`;
export const fryWord = (n) => count(n, ['малёк', 'малька', 'мальков']);
export const fishWord = (n) => count(n, ['рыбка', 'рыбки', 'рыбок']);

/** "3 дня", "5 часов 20 мин", "12 мин" */
export function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60000)), hr = Math.floor(m / 60), d = Math.floor(hr / 24);
  if (d >= 1) return `${count(d, ['день', 'дня', 'дней'])}${d < 3 && hr % 24 ? ` ${count(hr % 24, ['час', 'часа', 'часов'])}` : ''}`;
  if (hr >= 1) return `${count(hr, ['час', 'часа', 'часов'])}${m % 60 ? ` ${m % 60} мин` : ''}`;
  return `${m} мин`;
}
