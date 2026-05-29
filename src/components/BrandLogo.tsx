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

const titleSizeMap: Record<BrandLogoSize, string> = {
  sm: 'text-[22px] leading-none',
  md: 'text-[28px] leading-none',
  lg: 'text-[34px] leading-none',
  xl: 'text-[46px] leading-none',
};

const taglineSizeMap: Record<BrandLogoSize, string> = {
  sm: 'text-[9px] tracking-[0.28em]',
  md: 'text-[10px] tracking-[0.3em]',
  lg: 'text-[11px] tracking-[0.32em]',
  xl: 'text-[13px] tracking-[0.34em]',
};

const toneMap: Record<BrandLogoTone, { title: string; tagline: string }> = {
  light: {
    title: 'text-[#16345a]',
    tagline: 'text-[#c79212]',
  },
  dark: {
    title: 'text-white',
    tagline: 'text-[#f7cd53]',
  },
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
      className={cn('flex flex-col items-start gap-1', className)}
      aria-label="VaronEnglish"
      data-tone={tone}
      data-show-tagline={showTagline}
    >
      <span
        className={cn(
          'font-black tracking-[-0.05em]',
          titleSizeMap[size],
          toneMap[tone].title,
        )}
      >
        VaronEnglish
      </span>
      {showTagline ? (
        <span
          className={cn(
            'font-semibold uppercase leading-none',
            taglineSizeMap[size],
            toneMap[tone].tagline,
          )}
        >
          For Competitive Exams
        </span>
      ) : null}
    </div>
  );
};
