import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BellRing,
  BookOpen,
  CalendarClock,
  ChevronRight,
  ClipboardList,
  FileText,
  Radio,
  Target,
} from 'lucide-react';
import { CourseCard, LiveClass, MockTest, NotificationItem, PlatformOverview } from '../types';
import { LIVE_CLASSES_ENABLED } from '../lib/featureFlags';

type OverviewFigmaTabProps = {
  overview: PlatformOverview;
  onContinueLearning: (courseId: string, lessonId?: string | null) => void;
  onOpenNotification?: (notification: NotificationItem) => void;
  onOpenLiveTab?: () => void;
  onOpenTestsTab?: () => void;
  onOpenRevisionTab?: () => void;
  onOpenCoursesTab?: () => void;
};

const overviewFontStack = 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const formatNumber = (value: number) => new Intl.NumberFormat('en-IN').format(Math.max(Math.round(value || 0), 0));

const formatPercent = (value: number) => `${Math.max(Math.round(value || 0), 0)}%`;

const isSameLocalDay = (value: string | null | undefined, date: Date) => {
  if (!value) {
    return false;
  }

  const parsed = new Date(value);
  return parsed.getFullYear() === date.getFullYear()
    && parsed.getMonth() === date.getMonth()
    && parsed.getDate() === date.getDate();
};

const formatClassTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value));

const formatAnnouncementTime = (value: string) =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));

const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const getCourseSubtitle = (course: CourseCard) =>
  [course.exam, course.subject].filter(Boolean).join(' | ') || course.category || course.level || 'Course';

const getDiscountedCoursePrice = (course: CourseCard) => {
  const basePrice = Math.max(Number(course.price || 0), 1);
  const offerPercentage = Math.min(Math.max(Number(course.offerPercentage || 0), 0), 100);
  const discountedPrice = basePrice * (1 - (offerPercentage / 100));
  return Math.max(Number(discountedPrice.toFixed(2)), 1);
};

const getOverviewCoursePricing = (course: CourseCard) => {
  const basePrice = Math.max(Number(course.price || 0), 1);
  const finalPrice = getDiscountedCoursePrice(course);
  const offerPercentage = Number(course.offerPercentage || 0);
  const savings = Math.max(basePrice - finalPrice, 0);
  const hasOffer = offerPercentage > 0 && savings > 0 && finalPrice < basePrice;

  return {
    basePrice,
    finalPrice,
    offerPercentage,
    savings,
    hasOffer,
  };
};

const getCourseInitials = (course: CourseCard) =>
  (course.title || course.exam || 'Course')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'EM';

const getCompletedLessonCount = (course: CourseCard) =>
  (course.lessonProgress || []).filter((entry) => entry.completed || Number(entry.progressPercent || 0) >= 90).length;

const getCourseQuestionCount = (tests: MockTest[], course: CourseCard) =>
  tests
    .filter((test) => {
      const haystack = [test.course, test.category, test.title, test.description].join(' ').toLowerCase();
      return haystack.includes(course._id.toLowerCase())
        || (course.exam && haystack.includes(course.exam.toLowerCase()))
        || (course.category && haystack.includes(course.category.toLowerCase()));
    })
    .reduce((sum, test) => sum + (test.questions?.length || 0), 0);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[15px] font-bold text-[#17233d]">{children}</p>
);

const EmptyState = ({
  title,
  body,
  action,
  onClick,
}: {
  title: string;
  body: string;
  action?: string;
  onClick?: () => void;
}) => (
  <div className="rounded-[16px] border border-dashed border-[#c8d6ea] bg-white px-[14px] py-[14px]">
    <p className="text-[14px] font-bold text-[#17233d]">{title}</p>
    <p className="mt-[6px] text-[13px] leading-6 text-[#53647d]">{body}</p>
    {action && onClick && (
      <button
        type="button"
        onClick={onClick}
        className="mt-[10px] inline-flex items-center gap-1 text-[13px] font-semibold text-[#2f6fe4]"
      >
        {action}
        <ChevronRight className="h-4 w-4" />
      </button>
    )}
  </div>
);

const CourseIcon = ({
  tone,
  children,
}: {
  tone: 'blue' | 'green' | 'purple';
  children: React.ReactNode;
}) => {
  const palette = {
    blue: 'bg-[#ecf3ff] text-[#2f6fe4]',
    green: 'bg-[#e9f8ee] text-[#28a45e]',
    purple: 'bg-[#f3efff] text-[#6a58d6]',
  } as const;

  return (
    <div className={`flex h-[42px] w-[42px] items-center justify-center rounded-[12px] ${palette[tone]}`}>
      {children}
    </div>
  );
};

const ProgressRing = ({ value }: { value: number }) => {
  const percent = Math.max(Math.min(Math.round(value || 0), 100), 0);
  const background = `conic-gradient(#2f6fe4 ${percent * 3.6}deg, #d9e7ff 0deg)`;

  return (
    <div className="flex flex-col items-center">
      <div className="relative flex h-[90px] w-[90px] items-center justify-center rounded-full" style={{ background }}>
        <div className="flex h-[64px] w-[64px] items-center justify-center rounded-full bg-white text-[18px] font-semibold text-[#17233d]">
          {percent}%
        </div>
      </div>
      <p className="mt-[10px] text-[13px] font-medium text-[#536682]">Course progress</p>
    </div>
  );
};

const ActiveMetric = ({ value, label }: { value: string; label: string }) => (
  <div className="min-w-0 border-r border-[#eef2f8] pr-[18px] last:border-r-0 last:pr-0">
    <p className="text-[13px] font-bold leading-none text-[#17233d]">{value}</p>
    <p className="mt-[8px] text-[12px] leading-none text-[#5f6f86]">{label}</p>
  </div>
);

const ActiveCoursePanel = ({
  course,
  tests,
  iconTone,
  icon,
  testId,
  onClick,
}: {
  course: CourseCard;
  tests: MockTest[];
  iconTone: 'blue' | 'green';
  icon: React.ReactNode;
  testId: string;
  onClick: () => void;
}) => {
  const progressPercent = Math.max(Math.min(Math.round(course.progressPercent || 0), 100), 0);
  const completedLessons = getCompletedLessonCount(course);

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex min-w-0 flex-col text-left"
    >
      <div className="flex items-start gap-[14px]">
        <CourseIcon tone={iconTone}>{icon}</CourseIcon>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-[#17233d]">{course.title}</p>
          <p className="mt-[4px] truncate text-[14px] text-[#53647d]">{getCourseSubtitle(course)}</p>
        </div>
      </div>

      <div className="mt-[18px] flex items-center justify-between gap-3">
        <p className="text-[12px] font-medium text-[#53647d]">{formatPercent(progressPercent)} complete</p>
        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#2f6fe4]">
          Continue
          <ChevronRight className="h-4 w-4" />
        </span>
      </div>

      <div className="mt-[8px] h-[6px] rounded-full bg-[#edf2f9]">
        <div className="h-full rounded-full bg-[#2f6fe4]" style={{ width: `${Math.max(progressPercent, progressPercent > 0 ? 4 : 0)}%` }} />
      </div>

      <div className="mt-[18px] grid grid-cols-3 gap-[18px]">
        <ActiveMetric value={formatNumber(completedLessons)} label="Done" />
        <ActiveMetric value={formatNumber(course.lessonCount || 0)} label="Lessons" />
        <ActiveMetric value={formatNumber(getCourseQuestionCount(tests, course))} label="Questions" />
      </div>
    </button>
  );
};

const BottomLink = ({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick?: () => void;
  testId?: string;
}) => (
  <button
    type="button"
    data-testid={testId}
    onClick={onClick}
    className="mt-[16px] flex w-full items-center justify-between border-t border-[#eef2f7] pt-[12px] text-[13px] font-semibold text-[#2f6fe4]"
  >
    <span>{label}</span>
    <ChevronRight className="h-4 w-4" />
  </button>
);

const HeroArtwork = () => (
  <div className="absolute inset-0 bg-[#eef4ff]">
    <div className="absolute inset-x-0 bottom-0 h-[46%] bg-[#ddeaff]" />
    <div className="absolute -right-[52px] top-[24px] h-[138px] w-[138px] rounded-full bg-white/58" />
    <div className="absolute bottom-[30px] left-[160px] h-[18px] w-[72%] rounded-full bg-[#c8dcff]/70" />
  </div>
);

const ClassItem = ({ item, onOpenLiveTab }: { item: LiveClass; onOpenLiveTab?: () => void }) => {
  const isLive = item.status === 'live';

  return (
    <div className="relative pb-[18px] last:pb-0">
      <span className={`absolute -left-[18px] top-[2px] h-[12px] w-[12px] rounded-full border-[3px] bg-white ${isLive ? 'border-[#ee4f74]' : 'border-[#8a97ab]'}`} />
      <div className="flex items-start justify-between gap-[10px]">
        <div className="min-w-0">
          <div className="flex items-center gap-[8px]">
            {isLive && <span className="rounded-full bg-[#ff5b6d] px-[8px] py-[2px] text-[10px] font-semibold uppercase text-white">Live</span>}
            <p className="truncate text-[13px] font-semibold text-[#17233d]">{item.title}</p>
          </div>
          <p className="mt-[8px] text-[13px] text-[#5f7096]">{item.instructor || item.topicTags?.[0] || 'Live class'}</p>
          <p className="mt-[8px] text-[12px] text-[#5f6f86]">{formatClassTime(item.startTime)} | {item.durationMinutes} min</p>
        </div>
        <button
          type="button"
          data-testid={isLive ? 'overview-join-now-button' : undefined}
          onClick={onOpenLiveTab}
          className="shrink-0 text-[13px] font-semibold text-[#2f6fe4]"
        >
          {isLive ? 'Join' : 'Open'}
        </button>
      </div>
    </div>
  );
};

export const OverviewFigmaTab = ({
  overview,
  onContinueLearning,
  onOpenNotification,
  onOpenLiveTab,
  onOpenTestsTab,
  onOpenRevisionTab,
  onOpenCoursesTab,
}: OverviewFigmaTabProps) => {
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [mobileCoursePage, setMobileCoursePage] = useState(0);
  const mobileCourseRailRef = useRef<HTMLDivElement | null>(null);
  const autoScrollTouchedAtRef = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const updateLayout = () => {
      setIsMobileLayout(window.matchMedia('(max-width: 1023px)').matches);
    };

    updateLayout();
    window.addEventListener('resize', updateLayout);

    return () => {
      window.removeEventListener('resize', updateLayout);
    };
  }, []);

  const today = useMemo(() => new Date(), []);
  const learnerName = overview.user?.name || 'Learner';
  const activeCourses = useMemo(
    () => overview.courses
      .filter((course) => course.enrolled)
      .sort((left, right) => Number(right.progressPercent || 0) - Number(left.progressPercent || 0)),
    [overview.courses],
  );
  const heroCourse = overview.dashboard.continueLearning[0] || activeCourses[0] || null;
  const secondaryCourse = activeCourses.find((course) => course._id !== heroCourse?._id) || null;
  const activeCourseCards = [heroCourse, secondaryCourse].filter(Boolean) as CourseCard[];
  const mobileCarouselCourses = useMemo(
    () => {
      const seen = new Set<string>();
      const ordered = overview.courses.filter((course) => {
        if (!course || seen.has(course._id)) {
          return false;
        }

        seen.add(course._id);
        return true;
      });
      return ordered.length > 0 ? ordered : activeCourseCards;
    },
    [activeCourseCards, overview.courses],
  );
  const mobileCarouselPageCount = Math.max(Math.ceil(mobileCarouselCourses.length / 2), 1);
  const todayClasses = useMemo(
    () => overview.liveClasses
      .filter((item) => ['live', 'scheduled'].includes(String(item.status || 'scheduled')) && isSameLocalDay(item.startTime, today))
      .sort((left, right) => new Date(left.startTime).getTime() - new Date(right.startTime).getTime())
      .slice(0, 2),
    [overview.liveClasses, today],
  );
  const availableTest = overview.testSeries[0] || null;
  const latestMock = overview.dashboard.latestMockTest;
  const scorePercent = latestMock?.totalMarks ? Math.round((latestMock.score / latestMock.totalMarks) * 100) : 0;
  const revisionTopics = (overview.analytics.weakTopics.length > 0 ? overview.analytics.weakTopics : []).slice(0, 2);
  const availableCbtCount = useMemo(
    () => overview.courses.reduce((count, course) => (
      count + (course.modules || []).reduce((moduleCount, module) => (
        moduleCount
        + (module.lessons || []).filter((lesson) => lesson.cbt?.questions?.length).length
        + (module.chapters || []).reduce((chapterCount, chapter) => (
          chapterCount + (chapter.lessons || []).filter((lesson) => lesson.cbt?.questions?.length).length
        ), 0)
      ), 0)
    ), 0),
    [overview.courses],
  );
  const recommendation = overview.analytics.attempts > 0
    ? overview.analytics.suggestions[0] || overview.analytics.adaptivePlan.reason
    : null;
  const announcementItems = useMemo(
    () => (overview.notifications || [])
      .filter((notification) => {
        const type = String(notification.type || '').toLowerCase();
        return type === 'announcement' || type.includes('announcement') || type.includes('news');
      })
      .sort((left, right) => {
        if (Boolean(left.isRead) !== Boolean(right.isRead)) {
          return left.isRead ? 1 : -1;
        }
        return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      })
      .slice(0, 3),
    [overview.notifications],
  );

  const openCourse = (course: CourseCard | null) => {
    if (!course) {
      return;
    }

    onContinueLearning(course._id, null);
  };

  useEffect(() => {
    if (!isMobileLayout || mobileCarouselCourses.length <= 2) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      const rail = mobileCourseRailRef.current;
      if (!rail || Date.now() - autoScrollTouchedAtRef.current < 1800) {
        return;
      }

      const nextPage = (mobileCoursePage + 1) % mobileCarouselPageCount;
      const maxScrollLeft = rail.scrollWidth - rail.clientWidth;
      rail.scrollTo({
        left: Math.min(nextPage * rail.clientWidth, maxScrollLeft),
        behavior: 'smooth',
      });
      setMobileCoursePage(nextPage);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [isMobileLayout, mobileCarouselCourses.length, mobileCarouselPageCount, mobileCoursePage]);

  const handleMobileCourseScroll = () => {
    const rail = mobileCourseRailRef.current;
    if (!rail) {
      return;
    }

    autoScrollTouchedAtRef.current = Date.now();
    const nextPage = Math.max(
      0,
      Math.min(Math.round(rail.scrollLeft / Math.max(rail.clientWidth, 1)), mobileCarouselPageCount - 1),
    );
    setMobileCoursePage(nextPage);
  };

  const renderMobileCourseArt = (tone: 'purple' | 'blue' | 'green', index: number) => {
    if (tone === 'blue') {
      return (
        <div className="pointer-events-none absolute bottom-[18px] right-[18px] h-[90px] w-[92px] opacity-75">
          <div className="absolute bottom-0 left-[30px] h-[54px] w-[26px] rounded-b-[12px] bg-[linear-gradient(180deg,rgba(255,255,255,0.72),rgba(42,122,225,0.58))] shadow-[inset_0_-6px_12px_rgba(14,92,190,0.28)]" />
          <div className="absolute left-[18px] top-[7px] h-[56px] w-[56px] rounded-full bg-[radial-gradient(circle_at_38%_35%,rgba(255,255,255,0.78),rgba(113,184,255,0.72)_42%,rgba(28,107,214,0.42)_78%)] shadow-[0_12px_26px_rgba(24,91,190,0.28)]" />
          <div className="absolute left-[2px] top-[43px] h-[26px] w-[26px] rounded-full border-[9px] border-[#4aa5ef]/55" />
          <div className="absolute right-0 top-[43px] h-[26px] w-[26px] rounded-full border-[9px] border-[#4aa5ef]/55" />
          <div className="absolute left-[42px] top-[31px] h-[35px] w-[4px] rounded-full bg-white/54" />
          <div className="absolute left-[33px] top-[35px] h-[22px] w-[22px] rounded-full border-[4px] border-white/50 border-t-transparent" />
        </div>
      );
    }

    if (tone === 'green') {
      return (
        <div className="pointer-events-none absolute bottom-[18px] right-[20px] h-[86px] w-[94px] opacity-72">
          <div className="absolute bottom-[10px] left-[16px] h-[44px] w-[60px] rounded-[16px] bg-white/24" />
          <div className="absolute bottom-[18px] left-[10px] h-[38px] w-[52px] -rotate-12 rounded-[9px] bg-[linear-gradient(180deg,rgba(255,255,255,0.55),rgba(20,157,112,0.38))] shadow-[0_10px_20px_rgba(10,101,86,0.18)]" />
          <div className="absolute bottom-[18px] right-[8px] h-[38px] w-[38px] rounded-full border-[10px] border-white/32" />
          <div className="absolute right-[22px] top-[6px] h-[16px] w-[16px] rounded-full bg-white/26" />
          <div className="absolute right-[42px] top-[17px] h-[10px] w-[10px] rounded-full bg-white/22" />
        </div>
      );
    }

    return (
      <div className="pointer-events-none absolute bottom-[18px] right-[18px] h-[92px] w-[100px] opacity-76">
        <div className="absolute bottom-[16px] left-[18px] h-[42px] w-[54px] -rotate-12 rounded-r-full bg-[linear-gradient(90deg,rgba(255,255,255,0.44),rgba(255,255,255,0.18))] shadow-[0_10px_20px_rgba(45,33,145,0.22)]" />
        <div className="absolute bottom-[24px] left-[48px] h-[42px] w-[22px] rotate-[-18deg] rounded-r-full bg-white/24" />
        <div className="absolute bottom-[14px] left-[31px] h-[28px] w-[12px] -rotate-12 rounded-[4px] bg-[#3525a3]/28" />
        <div className="absolute bottom-[14px] right-[8px] h-[58px] w-[58px] rounded-full border-[11px] border-white/24" />
        <div className="absolute bottom-[29px] right-[23px] h-[28px] w-[28px] rounded-full border-[8px] border-white/28" />
        <div className="absolute bottom-[40px] right-[5px] h-[8px] w-[30px] -rotate-35 rounded-full bg-[#1f236e]/30" />
        {index % 2 === 0 && (
          <div className="absolute right-[31px] top-[6px] h-[28px] w-[34px] rounded-[8px] bg-[#2b237d]/24">
            <div className="mt-[9px] flex justify-center gap-[4px]">
              <span className="h-[5px] w-[5px] rounded-full bg-white/55" />
              <span className="h-[5px] w-[5px] rounded-full bg-white/55" />
              <span className="h-[5px] w-[5px] rounded-full bg-white/55" />
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderMobileCourseCarousel = () => (
    <section data-testid="overview-active-courses" className="space-y-[10px]">
      <div className="flex items-center justify-between">
        <SectionTitle>Courses</SectionTitle>
        <button
          type="button"
          onClick={onOpenCoursesTab}
          className="shrink-0 text-[13px] font-semibold text-[#2f6fe4]"
        >
          View all
        </button>
      </div>

      {mobileCarouselCourses.length === 0 ? (
        <EmptyState title="No active courses" body="Purchased course enrollments will appear here after the learner buys access." />
      ) : (
        <>
          <div
            ref={mobileCourseRailRef}
            data-testid="overview-course-carousel"
            onScroll={handleMobileCourseScroll}
            onPointerDown={() => { autoScrollTouchedAtRef.current = Date.now(); }}
            onTouchStart={() => { autoScrollTouchedAtRef.current = Date.now(); }}
            className="-mx-[2px] flex snap-x snap-mandatory gap-[12px] overflow-x-auto scroll-smooth px-[2px] pb-[2px] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {mobileCarouselCourses.map((course, index) => {
              const tone = index % 3 === 1 ? 'blue' : index % 3 === 2 ? 'green' : 'purple';

              return (
                <button
                  key={course._id}
                  type="button"
                  data-testid={`overview-active-course-card-${index}`}
                  onClick={() => openCourse(course)}
                  className={`relative h-[182px] shrink-0 snap-start overflow-hidden rounded-[12px] px-[11px] py-[14px] text-left text-white shadow-[0_16px_30px_rgba(22,62,128,0.14)] ${tone === 'blue'
                    ? 'bg-[linear-gradient(135deg,#1776d8_0%,#35a2ff_100%)]'
                    : tone === 'green'
                      ? 'bg-[linear-gradient(135deg,#11966f_0%,#36caa1_100%)]'
                      : 'bg-[linear-gradient(135deg,#4b39d4_0%,#7d48fb_100%)]'}`}
                  style={{ flexBasis: mobileCarouselCourses.length > 1 ? 'calc((100% - 12px) / 2)' : '100%' }}
                >
                  <div className={`relative z-10 flex h-[32px] w-[32px] items-center justify-center rounded-[7px] text-[16px] font-bold ${tone === 'blue'
                    ? 'bg-[#20b56f]'
                    : tone === 'green'
                      ? 'bg-[#159d72]'
                      : 'bg-[#7848ee]'}`}
                  >
                    {getCourseInitials(course)}
                  </div>
                  <p className="relative z-10 mt-[12px] line-clamp-2 max-w-[112px] text-[16px] font-extrabold leading-[1.12] text-white drop-shadow-[0_1px_1px_rgba(16,33,77,0.12)]">
                    {course.title}
                  </p>
                  <p className="relative z-10 mt-[7px] max-w-[112px] truncate text-[12px] font-semibold text-white/92">
                    {getCourseSubtitle(course)}
                  </p>
                  {!course.enrolled && (
                    <div className="relative z-10 mt-[10px] inline-flex max-w-[138px] flex-col rounded-[10px] bg-white/18 px-[8px] py-[7px] backdrop-blur-[6px]">
                      {getOverviewCoursePricing(course).hasOffer && (
                        <p className="text-[9px] font-semibold uppercase tracking-[0.08em] text-white/74">Offer price</p>
                      )}
                      <p className="mt-[2px] text-[13px] font-extrabold text-white">
                        {currency.format(getOverviewCoursePricing(course).finalPrice)}
                      </p>
                      {getOverviewCoursePricing(course).hasOffer && (
                        <div className="mt-[3px] flex items-center gap-[5px] text-[9px] font-semibold text-white/84">
                          <span className="line-through decoration-white/65">{currency.format(getOverviewCoursePricing(course).basePrice)}</span>
                          <span className="rounded-full bg-[#ffd36f] px-[5px] py-[1px] text-[#6a3b00]">
                            {getOverviewCoursePricing(course).offerPercentage}% OFF
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {renderMobileCourseArt(tone, index)}
                </button>
              );
            })}
          </div>

          <div className="flex h-[18px] items-center justify-center">
            <div className="flex items-center gap-[8px]">
              {Array.from({ length: mobileCarouselPageCount }).map((_, index) => (
                <button
                  key={index}
                  type="button"
                  aria-label={`Show course page ${index + 1}`}
                  onClick={() => {
                    const rail = mobileCourseRailRef.current;
                    autoScrollTouchedAtRef.current = Date.now();
                    setMobileCoursePage(index);
                    rail?.scrollTo({ left: index * rail.clientWidth, behavior: 'smooth' });
                  }}
                  className={`h-[11px] w-[11px] rounded-full ${mobileCoursePage === index ? 'bg-[#0965e9]' : 'bg-[#d6dde8]'}`}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );

  const renderHeader = () => (
    <div data-testid="overview-topbar" className="flex min-w-0 items-start justify-between gap-[12px]">
      <div className="min-w-0">
        <p className="truncate text-[15px] font-semibold text-[#202a44]">Welcome back, {learnerName}</p>
        <p className="mt-[6px] text-[13px] leading-[1.45] text-[#5f6f86]">Your dashboard is based on live course, test, and class activity.</p>
      </div>

    </div>
  );

  const renderHero = () => (
    <section
      data-testid="overview-hero"
      className="relative overflow-hidden rounded-[18px] border border-[#d7e2f0] bg-[#edf4ff] shadow-[0_10px_28px_rgba(28,41,61,0.06)]"
    >
      <HeroArtwork />
      <div className="relative z-10 flex min-h-[190px] items-start justify-between gap-6 px-[20px] py-[20px]">
        <div className="max-w-[520px]">
          <div className="flex items-center gap-[10px] text-[14px] font-semibold text-[#34547d]">
            <span>{heroCourse ? 'Continue learning' : 'Learning workspace'}</span>
            {heroCourse && (
              <span className="rounded-[6px] bg-[#e3eeff] px-[6px] py-[1px] text-[12px] font-semibold text-[#2f6fe4]">
                {formatPercent(heroCourse.progressPercent || 0)}
              </span>
            )}
          </div>

          <p className="mt-[12px] text-[20px] font-bold leading-[1.35] tracking-[-0.02em] text-[#17233d]">
            {heroCourse?.title || 'No active course yet'}
          </p>

          <p className="mt-[10px] max-w-[460px] text-[14px] leading-[1.65] text-[#50627d]">
            {heroCourse?.continueLesson
              ? `Next lesson: ${heroCourse.continueLesson.title}`
              : heroCourse
                ? getCourseSubtitle(heroCourse)
                : 'Enroll in a course to start tracking lessons, progress, and tests here.'}
          </p>

          {heroCourse && (
            <button
              type="button"
              data-testid="overview-continue-cta"
              onClick={() => openCourse(heroCourse)}
              className="mt-[16px] inline-flex h-[40px] min-w-[160px] items-center justify-between rounded-[10px] bg-[#2f6fe4] px-[16px] text-[13px] font-semibold text-white shadow-[0_10px_20px_rgba(47,111,228,0.2)]"
            >
              Continue
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>

        {heroCourse && (
          <div className="hidden shrink-0 pt-[8px] lg:block">
            <ProgressRing value={heroCourse.progressPercent || 0} />
          </div>
        )}
      </div>
    </section>
  );

  const renderCourses = () => (
    <section data-testid="overview-active-courses" className="space-y-[10px]">
      <SectionTitle>Active Courses</SectionTitle>
      {activeCourseCards.length === 0 ? (
        <EmptyState title="No active courses" body="Purchased course enrollments will appear here after the learner buys access." />
      ) : (
        <div className="grid grid-cols-1 rounded-[18px] border border-[#dbe5f2] bg-white shadow-[0_10px_28px_rgba(28,41,61,0.06)] lg:grid-cols-2">
          {activeCourseCards.map((course, index) => (
            <div key={course._id} className="px-[18px] py-[18px] lg:border-r lg:border-[#eef2f8] lg:last:border-r-0">
              <ActiveCoursePanel
                testId={`overview-active-course-card-${index}`}
                course={course}
                tests={overview.testSeries}
                iconTone={index === 0 ? 'blue' : 'green'}
                icon={index === 0 ? <BookOpen className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
                onClick={() => openCourse(course)}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );

  const renderPerformance = () => (
    <section data-testid="overview-signals" className="space-y-[10px]">
      <SectionTitle>Performance Overview</SectionTitle>
      <div className="grid grid-cols-1 rounded-[18px] border border-[#dbe5f2] bg-white shadow-[0_10px_28px_rgba(28,41,61,0.06)] lg:grid-cols-[minmax(0,1.08fr)_330px]">
        <div data-testid="overview-streak" className="px-[18px] py-[16px] lg:border-r lg:border-[#eef2f8]">
          <div className="flex items-start gap-[12px]">
            <CourseIcon tone="green">
              <Activity className="h-5 w-5" />
            </CourseIcon>
            <div>
              <p className="text-[14px] font-semibold text-[#17233d]">Learning Activity</p>
              <div className="mt-[12px] space-y-[10px]">
                <div className="flex items-center gap-[10px] text-[13px] text-[#53647d]">
                  <ClipboardList className="h-4 w-4 text-[#9aa8bb]" />
                  <span>{availableCbtCount > 0 ? `${availableCbtCount} CBT${availableCbtCount > 1 ? 's' : ''} available` : 'No CBT published yet'}</span>
                </div>
                <div className="flex items-center gap-[10px] text-[13px] text-[#53647d]">
                  <CalendarClock className="h-4 w-4 text-[#f0b557]" />
                  <span>{todayClasses.length > 0 ? `${todayClasses.length} class${todayClasses.length > 1 ? 'es' : ''} today` : 'No classes scheduled today'}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-[18px] flex items-center justify-between gap-3">
            <p className="text-[13px] text-[#53647d]">{formatNumber(overview.dashboard.streak)} day streak</p>
            <button
              type="button"
              data-testid="overview-streak-continue-button"
              onClick={onOpenCoursesTab}
              className="inline-flex items-center gap-1 text-[13px] font-semibold text-[#2f6fe4]"
            >
              Open Courses
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div data-testid="overview-score-summary" className="px-[18px] py-[16px]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[12px] text-[#53647d]">Accuracy</p>
              <p className="mt-[6px] text-[16px] font-semibold text-[#17233d]">{formatPercent(overview.analytics.accuracy)}</p>
            </div>
            <div className="text-right">
              <p className="text-[12px] text-[#53647d]">Attempts</p>
              <p className="mt-[6px] text-[16px] font-semibold text-[#17233d]">{formatNumber(overview.analytics.attempts)}</p>
            </div>
          </div>

          <div className="mt-[16px] h-[6px] rounded-full bg-[#dfe8f7]">
            <div className="h-full rounded-full bg-[#2f6fe4]" style={{ width: `${Math.max(Math.min(overview.analytics.accuracy, 100), 0)}%` }} />
          </div>

          <div className="mt-[14px] flex items-center justify-between gap-3">
            <p className="text-[12px] text-[#53647d]">Reward points</p>
            <p className="text-[13px] font-medium text-[#17233d]">{formatNumber(overview.dashboard.points)}</p>
          </div>
        </div>
      </div>
    </section>
  );

  const renderRecommendation = () => (
    <section className="space-y-[10px]">
      <SectionTitle>Recommended Track</SectionTitle>
      {recommendation ? (
        <div
          data-testid="overview-recommendation"
          className="flex items-center justify-between gap-[18px] rounded-[18px] border border-[#dbe5f2] bg-white px-[18px] py-[14px] shadow-[0_10px_28px_rgba(28,41,61,0.06)]"
        >
          <div className="flex min-w-0 items-center gap-[14px]">
            <CourseIcon tone="purple">
              <Target className="h-5 w-5" />
            </CourseIcon>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-[#17233d]">{overview.analytics.adaptivePlan.nextTestType} practice</p>
              <p className="mt-[4px] text-[13px] leading-6 text-[#53647d]">{recommendation}</p>
            </div>
          </div>

          <button
            type="button"
            data-testid="overview-review-now-button"
            onClick={onOpenRevisionTab}
            className="inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold text-[#2f6fe4]"
          >
            Review
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div data-testid="overview-recommendation">
          <EmptyState title="No recommendation yet" body="Recommendations are generated after CBT or mock-test activity is available." action="Open tests" onClick={onOpenTestsTab} />
        </div>
      )}
    </section>
  );

  const renderAnnouncements = () => (
    <section data-testid="overview-announcements" className="space-y-[10px]">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>Major Announcements</SectionTitle>
        <div className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[#eef4ff] text-[#2f6fe4]">
          <BellRing className="h-4 w-4" />
        </div>
      </div>
      {announcementItems.length === 0 ? (
        <EmptyState
          title="No announcements right now"
          body="Major news from admin will appear here when it is sent."
        />
      ) : (
        <div className="space-y-[12px]">
          {announcementItems.map((notification) => (
            <button
              key={notification._id}
              type="button"
              onClick={() => onOpenNotification?.(notification)}
              className={`w-full rounded-[18px] border px-[16px] py-[14px] text-left shadow-[0_8px_22px_rgba(28,41,61,0.05)] transition hover:border-[#c6d9f7] hover:bg-[#f8fbff] ${
                notification.isRead ? 'border-[#dbe5f2] bg-white' : 'border-[#d6e6ff] bg-[#eef5ff]'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-[#17233d]">{notification.title}</p>
                  <p className="mt-[6px] text-[13px] leading-6 text-[#53647d]">{notification.message}</p>
                </div>
                {!notification.isRead && (
                  <span className="shrink-0 rounded-full bg-[#2f6fe4] px-[8px] py-[3px] text-[10px] font-semibold uppercase tracking-[0.08em] text-white">
                    New
                  </span>
                )}
              </div>
              <div className="mt-[10px] flex items-center justify-between gap-3">
                <span className="text-[12px] text-[#6b7c95]">{formatAnnouncementTime(notification.createdAt)}</span>
                <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#2f6fe4]">
                  {notification.actionLabel || 'Open update'}
                  <ChevronRight className="h-4 w-4" />
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );

  const renderRevision = () => (
    <section className="space-y-[10px]">
      <SectionTitle>Quick Revision</SectionTitle>
      {revisionTopics.length === 0 ? (
        <EmptyState title="No weak topics yet" body="Weak-topic shortcuts will appear after completed CBTs or mock tests." action="Open Courses" onClick={onOpenCoursesTab} />
      ) : (
        <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-2">
          {revisionTopics.map((topic, index) => (
            <button
              key={topic}
              type="button"
              data-testid={`overview-revision-shortcut-${index}`}
              onClick={onOpenRevisionTab}
              className="flex h-[58px] items-center justify-between rounded-[14px] border border-[#dbe5f2] bg-white px-[14px] shadow-[0_6px_18px_rgba(28,41,61,0.05)]"
            >
              <div className="flex items-center gap-[12px]">
                <CourseIcon tone={index === 0 ? 'blue' : 'green'}>
                  <BookOpen className="h-4 w-4" />
                </CourseIcon>
                <div className="text-left">
                  <p className="text-[13px] font-semibold text-[#17233d]">{topic}</p>
                  <p className="mt-[3px] text-[12px] text-[#5f6f86]">Needs attention</p>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-[#8fa0b8]" />
            </button>
          ))}
        </div>
      )}
    </section>
  );

  const renderLiveSchedule = () => (
    <section
      data-testid="overview-upcoming-classes"
      className="rounded-[18px] border border-[#dbe5f2] bg-white px-[20px] py-[18px] shadow-[0_10px_28px_rgba(28,41,61,0.06)]"
    >
      <p className="text-[15px] font-semibold text-[#17233d]">Today&apos;s Schedule</p>
      {todayClasses.length === 0 ? (
        <div className="mt-[16px]">
          <EmptyState title="No classes today" body="Scheduled classes for today will appear here automatically." />
        </div>
      ) : (
        <div className="relative mt-[18px] pl-[18px]">
          <div className="absolute bottom-[20px] left-[6px] top-[8px] w-px bg-[#ebeff6]" />
          {todayClasses.map((item) => (
            <ClassItem key={item._id} item={item} onOpenLiveTab={onOpenLiveTab} />
          ))}
        </div>
      )}
      <BottomLink label="View timetable" onClick={onOpenLiveTab} testId="overview-view-timetable-button" />
    </section>
  );

  const renderTests = () => (
    <section
      data-testid="overview-upcoming-tests"
      className="rounded-[18px] border border-[#dbe5f2] bg-white px-[20px] py-[18px] shadow-[0_10px_28px_rgba(28,41,61,0.06)]"
    >
      <p className="text-[15px] font-semibold text-[#17233d]">Tests</p>
      {availableTest ? (
        <div className="mt-[18px]">
          <div className="flex items-start gap-[12px]">
            <CourseIcon tone="blue">
              <ClipboardList className="h-5 w-5" />
            </CourseIcon>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold text-[#17233d]">{availableTest.title}</p>
              <p className="mt-[4px] text-[12px] text-[#5f6f86]">{availableTest.questions.length} questions | {availableTest.durationMinutes} min</p>
            </div>
          </div>

          <div className="mt-[14px] flex items-end justify-between gap-3">
            <p className="text-[13px] text-[#5f6f86]">{availableTest.type || availableTest.category}</p>
            <button
              type="button"
              data-testid="overview-attempt-now-button"
              onClick={onOpenTestsTab}
              className="text-[13px] font-semibold text-[#2f6fe4]"
            >
              Open
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-[16px]">
          <EmptyState title="No tests published" body="Admin-created mock tests will appear here when available." />
        </div>
      )}
      <BottomLink label="View all tests" onClick={onOpenTestsTab} />
    </section>
  );

  const renderProgress = () => (
    <section
      data-testid="overview-score-card"
      className="rounded-[18px] border border-[#dbe5f2] bg-white px-[20px] py-[18px] shadow-[0_10px_28px_rgba(28,41,61,0.06)]"
    >
      <p className="text-[15px] font-semibold text-[#17233d]">Latest Result</p>
      {latestMock ? (
        <>
          <div className="mt-[16px] flex items-start justify-between gap-4">
            <div>
              <p className="text-[12px] text-[#53647d]">Score</p>
              <p className="mt-[4px] text-[16px] font-semibold text-[#17233d]">{formatNumber(latestMock.score)}/{formatNumber(latestMock.totalMarks)}</p>
            </div>
            <div className="text-right">
              <p className="text-[12px] text-[#53647d]">Rank</p>
              <p className="mt-[4px] text-[16px] font-semibold text-[#17233d]">
                {latestMock.rankStatus === 'ready' && latestMock.rank !== null ? `#${formatNumber(latestMock.rank)}` : 'Pending'}
              </p>
            </div>
          </div>

          <div className="mt-[14px] h-[6px] rounded-full bg-[#dfe8f7]">
            <div className="h-full rounded-full bg-[#2f6fe4]" style={{ width: `${scorePercent}%` }} />
          </div>

          <div className="mt-[12px] flex items-center justify-between gap-3">
            <p className="text-[12px] text-[#53647d]">Accuracy</p>
            <p className="text-[13px] font-medium text-[#17233d]">{formatPercent(scorePercent)}</p>
          </div>
        </>
      ) : (
        <div className="mt-[16px]">
          <EmptyState title="No test result yet" body="Submitted mock-test results will appear here with score, rank, and accuracy." action="Open tests" onClick={onOpenTestsTab} />
        </div>
      )}
    </section>
  );

  const renderSession = () => (
    <section className="rounded-[18px] border border-[#dbe5f2] bg-white px-[20px] py-[16px] shadow-[0_10px_28px_rgba(28,41,61,0.06)]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[15px] font-semibold text-[#17233d]">Session Status</p>
          <p className="mt-[8px] text-[12px] leading-[1.6] text-[#5f6f86]">
            {overview.sessionActivity
              ? `${overview.sessionActivity.activeSessions} active session${overview.sessionActivity.activeSessions === 1 ? '' : 's'}`
              : 'Sign in to track session activity.'}
          </p>
        </div>
        <CourseIcon tone="purple">
          <Radio className="h-5 w-5" />
        </CourseIcon>
      </div>
    </section>
  );

  if (isMobileLayout) {
    return (
      <div
        data-testid="overview-dashboard"
        className="mobile-safe-screen min-h-[100dvh] overflow-x-hidden overflow-y-auto bg-[#eef3fb] pb-[96px]"
        style={{ fontFamily: overviewFontStack }}
      >
        <div className="mobile-safe-content mx-auto space-y-[14px] pb-[18px] pt-[12px]">
          {renderHeader()}
          {renderMobileCourseCarousel()}
          {renderAnnouncements()}
          {renderPerformance()}
          {renderRecommendation()}
          {renderRevision()}
          <div data-testid="overview-action-queue" className="grid grid-cols-1 gap-[12px]">
            {LIVE_CLASSES_ENABLED && (onOpenLiveTab || todayClasses.length > 0) ? renderLiveSchedule() : null}
            {renderTests()}
            {renderProgress()}
            {renderSession()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="overview-dashboard"
      className="flex h-dvh min-h-dvh w-full flex-1 overflow-x-hidden overflow-y-auto bg-[#f7faff] lg:overflow-hidden"
      style={{ fontFamily: overviewFontStack }}
    >
      <div className="flex w-full flex-1 flex-col px-[24px] pb-[18px] pt-[20px] lg:px-[32px] lg:pb-[18px] lg:pt-[18px]">
        {renderHeader()}
        <div className="mt-[18px] grid min-h-0 flex-1 grid-cols-1 gap-[16px] lg:grid-cols-[minmax(0,1fr)_292px]">
          <div className="min-w-0 space-y-[14px]">
            {renderHero()}
            {renderAnnouncements()}
            {renderCourses()}
            {renderPerformance()}
            {renderRecommendation()}
            {renderRevision()}
          </div>

          <aside data-testid="overview-action-queue" className="space-y-[14px]">
            {LIVE_CLASSES_ENABLED && (onOpenLiveTab || todayClasses.length > 0) ? renderLiveSchedule() : null}
            {renderTests()}
            {renderProgress()}
            {renderSession()}
          </aside>
        </div>
      </div>
    </div>
  );
};
