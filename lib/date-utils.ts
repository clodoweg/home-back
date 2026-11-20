/**
 * Utility for parsing standard date range query parameters (start/end).
 * 
 * @param urlStr - The full URL string containing query parameters.
 * @returns Parsed Date objects and their raw string forms.
 */
export function parseDateRange(urlStr: string) {
    const { searchParams } = new URL(urlStr);
    const startStr = searchParams.get('start');
    const endStr = searchParams.get('end');

    const start = startStr ? new Date(startStr) : undefined;
    const end = endStr ? new Date(endStr) : undefined;

    return { start, end, startStr, endStr };
}
