/**
 * Session adapter. The ONLY file that knows the shape of GET /api/auth/me.
 * If the server changes the payload, change `adaptSession` and nothing else.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, ApiError } from './api';
import { ENDPOINTS } from './endpoints';
import { isRole, type Role } from './roles';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  contractorId: string | null;
  contractorName: string | null;
}

/** Expected server payload of GET /api/auth/me. */
export interface MeResponse {
  user: {
    id: string;
    email: string;
    fullName: string;
    role: string;
    contractorId: string | null;
    contractorName: string | null;
  };
}

export function adaptSession(raw: MeResponse): SessionUser {
  const u = raw.user;
  if (!isRole(u.role)) throw new ApiError(500, 'bad_session', `Unknown role "${u.role}"`);
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    contractorId: u.contractorId ?? null,
    contractorName: u.contractorName ?? null,
  };
}

export const SESSION_KEY = ['session'] as const;

export async function fetchSession(): Promise<SessionUser | null> {
  try {
    return adaptSession(await apiGet<MeResponse>(ENDPOINTS.me, { redirectOn401: false }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export function useSession() {
  const q = useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 5 * 60_000, retry: false });
  return { user: q.data ?? null, isLoading: q.isPending, error: q.error, refetch: q.refetch };
}

export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    try {
      await apiPost(ENDPOINTS.logout, undefined, { redirectOn401: false });
    } finally {
      qc.clear();
      window.location.assign('/login');
    }
  };
}
