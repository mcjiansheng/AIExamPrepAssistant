import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { RouterProvider } from 'react-router/dom';
import { ApiError } from './api/client';
import type { ApiMode } from './api/events';
import { router } from './router';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});

const ModeContext = createContext<ApiMode>('mock');
export const useApiMode = () => useContext(ModeContext);

export function App({ mode }: { mode: ApiMode }) {
  return (
    <ModeContext.Provider value={mode}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ModeContext.Provider>
  );
}
