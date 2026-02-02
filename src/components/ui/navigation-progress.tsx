import { useNavigation, useFetchers } from 'react-router';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Global navigation progress bar that shows at the top of the page
 * when a navigation or fetcher takes longer than 1 second.
 */
export function NavigationProgress() {
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const isNavigating = navigation.state !== 'idle';
  const hasFetcherLoading = fetchers.some(f => f.state !== 'idle');
  const isLoading = isNavigating || hasFetcherLoading;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isLoading) {
      // Only show progress bar if loading takes more than 1 second
      const timeout = setTimeout(() => {
        setVisible(true);
      }, 1000);

      return () => clearTimeout(timeout);
    } else {
      setVisible(false);
    }
  }, [isLoading]);

  return (
    <div
      className={cn(
        'fixed inset-x-0 top-0 z-50 h-0.5 pointer-events-none',
        'transition-opacity duration-300',
        visible ? 'opacity-100' : 'opacity-0'
      )}
    >
      <div className="h-full w-full overflow-hidden bg-primary/10">
        <div
          className={cn(
            'h-full bg-gradient-to-r from-transparent via-primary to-transparent',
            'animate-progress-shimmer'
          )}
        />
      </div>
      {/* Glow effect */}
      <div
        className={cn(
          'absolute inset-x-0 top-0 h-4 pointer-events-none',
          'bg-gradient-to-b from-primary/20 to-transparent',
          'animate-progress-glow'
        )}
      />
    </div>
  );
}
