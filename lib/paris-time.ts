/**
 * Paris time — conversions heure de Paris ↔ timestamps.
 * Home Assistant and the Petkit device express times in Europe/Paris while the server runs
 * in UTC on Vercel: every conversion goes through Intl with an explicit time zone.
 */

const PARIS_TIME_ZONE = 'Europe/Paris';

// Formatters are expensive to build and these helpers run inside sorts and filters
const parisComponentsFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: PARIS_TIME_ZONE,
    hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric',
});

const parisDayFormatter = new Intl.DateTimeFormat('fr-CA', {
    timeZone: PARIS_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
});

const parisClockFormatter = new Intl.DateTimeFormat('fr-FR', {
    timeZone: PARIS_TIME_ZONE,
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
});

/**
 * Construction d'un timestamp Unix stable pour l'heure locale PetKit (France).
 * Gère le décalage entre le serveur Vercel (UTC) et la maison.
 * Assure que '7h00' dans l'API PetKit devient le timestamp UTC correct pour Paris.
 *
 * @param y Année
 * @param m Mois (0-11)
 * @param d Jour du mois
 * @param hour Heure locale (0-23)
 * @param min Minute locale (0-59)
 * @returns Timestamp Unix en secondes
 */
export function getStableTimestamp(y: number, m: number, d: number, hour: number, min: number): number {
    // 1. On crée une date UTC naive avec les composants fournis (ex: 7h00 UTC)
    const utcNaive = Date.UTC(y, m, d, hour, min);

    // 2. On regarde quels composants Paris correspondent à cet instant (Intl gère le DST)
    const parts = parisComponentsFormatter.formatToParts(new Date(utcNaive));
    const find = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');

    const pHour = find('hour') === 24 ? 0 : find('hour');
    const parisNaive = Date.UTC(find('year'), find('month') - 1, find('day'), pHour, find('minute'));

    // La différence (composants Paris - composants UTC) représente l'offset de Paris :
    // on le retire pour obtenir l'instant UTC réel de "hour:min" à Paris.
    const offsetMs = parisNaive - utcNaive;
    return Math.floor((utcNaive - offsetMs) / 1000);
}

/**
 * Parse une chaîne de date HA (ex: "2026-03-17 00:32:00") en forçant le fuseau horaire Europe/Paris.
 * Indispensable pour que Vercel (UTC) et le Local (Paris) produisent le même timestamp.
 *
 * @param dateStr Date HA "YYYY-MM-DD HH:mm:ss" (le T, les millisecondes et le fuseau sont ignorés)
 * @returns Timestamp Unix en secondes, 0 si la date est absente ou invalide
 */
export function parseParisTimestamp(dateStr: string): number {
    if (!dateStr || dateStr === 'unknown' || dateStr === 'unavailable') return 0;

    const clean = dateStr.replace('T', ' ').split('.')[0].split('+')[0].split('Z')[0];
    const [datePart, timePart] = clean.split(' ');
    if (!datePart) return 0;

    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm, ss] = (timePart || '00:00:00').split(':').map(Number);

    if (isNaN(y) || isNaN(m) || isNaN(d)) return 0;

    return getStableTimestamp(y, m - 1, d, hh, mm) + (ss || 0);
}

/**
 * Retourne la date au format yyyyMMdd en forçant le fuseau horaire Europe/Paris.
 *
 * @param date Instant à convertir
 * @returns Jour de Paris, ex. 20260317
 */
export function getParisDayInt(date: Date): number {
    return parseInt(parisDayFormatter.format(date).replace(/-/g, ''));
}

/**
 * Retourne la date au format yyyy-MM-dd en forçant le fuseau horaire Europe/Paris.
 *
 * @param date Instant à convertir
 * @returns Jour de Paris, ex. "2026-03-17"
 */
export function getParisDayString(date: Date): string {
    return parisDayFormatter.format(date);
}

/**
 * Année, mois (0-11) et jour de Paris d'un instant, à passer à getStableTimestamp.
 *
 * @param date Instant à convertir
 * @returns Composants de date de Paris
 */
export function getParisDate(date: Date): { year: number; month: number; day: number } {
    const [year, month, day] = getParisDayString(date).split('-').map(Number);
    return { year, month: month - 1, day };
}

/**
 * Heure, minute et seconde de Paris d'un instant.
 *
 * @param date Instant à convertir
 * @returns Composants horaires de Paris
 */
export function getParisClock(date: Date): { hour: number; minute: number; second: number } {
    const parts = parisClockFormatter.formatToParts(date);
    const find = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');
    // Some engines format midnight as 24
    return { hour: find('hour') % 24, minute: find('minute'), second: find('second') };
}
