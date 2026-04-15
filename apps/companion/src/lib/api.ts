import axios from 'axios';
import { useAuthStore } from '@/stores/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
});

// ── Request interceptor: attach JWT ──
api.interceptors.request.use((config) => {
  const accessToken = useAuthStore.getState().accessToken;
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// ── Response interceptor: handle 401 ──
// Middleware handles redirecting to /login — we just clear the session here.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().clearSession();
    }
    return Promise.reject(error);
  },
);

// ── Auth endpoints ──
// Login goes through Auth.js signIn() — only register remains here.
export const authApi = {
  register: (email: string, password: string, displayName: string) =>
    api.post<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      user: any;
    }>('/auth/register', { email, password, display_name: displayName }),
};

// ── Trip endpoints ──
export const tripsApi = {
  list: (params?: { page?: number; status?: string }) =>
    api.get('/trips', { params }),

  get: (id: string) => api.get(`/trips/${id}`),

  create: (data: any) => api.post('/trips', data),

  update: (id: string, data: any) => api.patch(`/trips/${id}`, data),

  delete: (id: string) => api.delete(`/trips/${id}`),

  generate: (params: any) =>
    api.post('/trips/generate', params),

  invite: (tripId: string, email: string) =>
    api.post(`/trips/${tripId}/invite`, { email }),
};

// ── Road quality endpoints ──
export const roadsApi = {
  getSegment: (id: string) => api.get(`/roads/${id}`),

  search: (params: { bounds: string; quality?: string; surface?: string }) =>
    api.get('/roads/search', { params }),

  getHazards: (bounds: string) =>
    api.get('/roads/hazards', { params: { bounds } }),

  getFunZones: (bounds: string) =>
    api.get('/roads/fun-zones', { params: { bounds } }),
};

// ── Ride endpoints ──
export const ridesApi = {
  list: (params?: { page?: number; sort?: string }) =>
    api.get('/rides', { params }),

  get: (id: string) => api.get(`/rides/${id}`),

  getStats: () => api.get('/rides/stats'),

  getRoadMap: () => api.get('/rides/road-map'),

  export: (id: string, format: 'gpx' | 'csv') =>
    api.get(`/rides/${id}/export`, { params: { format }, responseType: 'blob' }),
};

// ── Community endpoints ──
export const communityApi = {
  feed: (params?: { page?: number; region?: string; sort?: string }) =>
    api.get('/community/feed', { params }),

  getProfile: (riderId: string) => api.get(`/riders/${riderId}`),

  follow: (riderId: string) => api.post(`/riders/${riderId}/follow`),

  unfollow: (riderId: string) => api.delete(`/riders/${riderId}/follow`),

  getCollections: (params?: { page?: number }) =>
    api.get('/community/collections', { params }),

  submitReview: (segmentId: string, data: { rating: number; text: string }) =>
    api.post(`/roads/${segmentId}/reviews`, data),
};

// ── Account endpoints ──
export const accountApi = {
  updateProfile: (data: any) => api.patch('/account/profile', data),

  getSubscription: () => api.get('/account/subscription'),

  getBikes: () => api.get('/account/bikes'),

  addBike: (data: any) => api.post('/account/bikes', data),

  updateBike: (id: string, data: any) => api.patch(`/account/bikes/${id}`, data),

  deleteBike: (id: string) => api.delete(`/account/bikes/${id}`),

  exportData: () => api.post('/account/export'),

  deleteAccount: () => api.delete('/account'),
};
