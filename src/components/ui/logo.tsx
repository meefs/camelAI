import { cn } from '@/lib/utils';

interface FullLogoProps {
  className?: string;
}

export function FullLogo({ className }: FullLogoProps) {
  return (
    <>
      <img
        src="/camelAI-fullname-logo-lightmode.svg"
        alt="camelAI"
        className={cn('block dark:hidden', className)}
      />
      <img
        src="/camelAI-fullname-logo-darkmode.svg"
        alt="camelAI"
        className={cn('hidden dark:block', className)}
      />
    </>
  );
}

interface LogoIconProps {
  className?: string;
}

export function LogoIcon({ className }: LogoIconProps) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      className={cn('size-6', className)}
    />
  );
}
