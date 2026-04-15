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
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response interceptor: handle 401 ──
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

// ── Auth endpoints ──
export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ user: any; token: string }>('/auth/login', { email, password }),

  register: (email: string, password: string, displayName: string) =>
    api.post<{ user: any; token: string }>('/auth/register', { email, password, displayName }),

  me: () => api.get('/auth/me'),
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
