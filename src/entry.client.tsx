import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';
import {
  initClientErrorReporting,
  reportClientError,
  scheduleClientErrorReload,
} from '@/lib/client-error-reporting';

initClientErrorReporting();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
    {
      onRecoverableError(error, errorInfo) {
        reportClientError({
          source: 'react_recoverable_error',
          error,
          componentStack: errorInfo.componentStack,
        });
        scheduleClientErrorReload({ error });
      },
    },
  );
});
