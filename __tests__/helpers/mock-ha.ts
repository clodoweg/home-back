/**
 * Mock Home Assistant API client.
 * Replaces haFetch/haGet/haPost with controllable mocks.
 */
import { vi } from 'vitest';
import { haFetch, haGet, haPost } from '@/lib/haClient';

const mockHaFetch = vi.mocked(haFetch);
const mockHaGet = vi.mocked(haGet);
const mockHaPost = vi.mocked(haPost);

/** Reset all HA mocks */
export function resetHAMocks() {
    mockHaFetch.mockReset();
    mockHaGet.mockReset();
    mockHaPost.mockReset();
}

/** Mock GET /api/states — return a list of HA entities */
export function mockHAStates(states: any[]) {
    mockHaFetch.mockResolvedValue({
        data: states,
        duration: 50,
        ok: true,
        status: 200,
    });
}

/** Mock POST /api/services/... — simulate a service call */
export function mockHACallService(response: any = {}) {
    mockHaPost.mockResolvedValue({
        data: response,
        duration: 30,
        ok: true,
        status: 200,
    });
}

/** Mock a failed HA response (covers haFetch, haGet, and haPost) */
export function mockHAError(status = 500) {
    const errorResponse = { data: null, duration: 100, ok: false, status };
    mockHaFetch.mockResolvedValue(errorResponse);
    mockHaGet.mockResolvedValue(errorResponse);
    mockHaPost.mockResolvedValue(errorResponse);
}

/** Mock haFetch directly (for more control) */
export function mockHAFetchResponse(data: any, ok = true, status = 200) {
    mockHaFetch.mockResolvedValue({ data, duration: 50, ok, status });
}

export { mockHaFetch, mockHaGet, mockHaPost };
