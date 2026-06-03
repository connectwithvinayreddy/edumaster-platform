import { cn } from '../lib/utils';

type BrandLogoTone = 'light' | 'dark';
type BrandLogoSize = 'sm' | 'md' | 'lg' | 'xl';

type BrandLogoProps = {
  className?: string;
  tone?: BrandLogoTone;
  size?: BrandLogoSize;
  showTagline?: boolean;
  hideText?: boolean;
};

const sizeMap: Record<BrandLogoSize, string> = {
  sm: 'h-10 w-10 sm:h-11 sm:w-11',
  md: 'h-12 w-12 sm:h-14 sm:w-14',
  lg: 'h-16 w-16 sm:h-20 sm:w-20',
  xl: 'h-24 w-24 sm:h-28 sm:w-28',
};

export const BrandLogo = ({
  className,
  tone = 'light',
  size = 'md',
  showTagline = true,
  hideText = false,
}: BrandLogoProps) => {
  if (hideText) {
    return <p className="sr-only">VaronEnglish</p>;
  }

  return (
    <div
      className={cn('flex items-center', className)}
      aria-label="VaronEnglish"
      data-tone={tone}
      data-show-tagline={showTagline}
    >
      <img
        src="/varonenglish-logo.png"
        alt="VaronEnglish for Competitive Exams"
        className={cn('max-w-full shrink-0 object-contain', sizeMap[size])}
        loading="eager"
      />
    </div>
  );
};
