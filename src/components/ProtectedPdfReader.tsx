import React, { useEffect, useRef, useState } from 'react';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { cn } from '../lib/utils';

type ProtectedPdfReaderProps = {
  sourceUrl?: string | null;
  requestHeaders?: Record<string, string>;
  title?: string | null;
  className?: string;
};

export const ProtectedPdfReader: React.FC<ProtectedPdfReaderProps> = ({
  sourceUrl,
  requestHeaders,
  title,
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [renderedPages, setRenderedPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return undefined;
    }

    const updateWidth = () => {
      const nextWidth = Math.max(260, Math.floor(element.clientWidth - 24));
      setContainerWidth(nextWidth);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    window.addEventListener('orientationchange', updateWidth);

    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', updateWidth);
    };
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return undefined;
    }

    const handleScroll = () => {
      const viewportTop = element.scrollTop + 24;
      let bestPage = 1;
      let bestDistance = Number.POSITIVE_INFINITY;
      pageRefs.current.forEach((pageElement, pageNumber) => {
        const distance = Math.abs(pageElement.offsetTop - viewportTop);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPage = pageNumber;
        }
      });
      setCurrentPage(bestPage);
    };

    element.addEventListener('scroll', handleScroll, { passive: true });
    return () => element.removeEventListener('scroll', handleScroll);
  }, [pageCount]);

  useEffect(() => {
    if (!sourceUrl || containerWidth <= 0) {
      setPageCount(0);
      setRenderedPages(0);
      setCurrentPage(1);
      setError('');
      return undefined;
    }

    let cancelled = false;
    let documentProxy: any = null;
    let loadingTask: any = null;

    const renderPdf = async () => {
      setPageCount(0);
      setRenderedPages(0);
      setCurrentPage(1);
      setError('');
      pageRefs.current.clear();
      canvasRefs.current.clear();

      try {
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        const source = {
          url: sourceUrl,
          httpHeaders: requestHeaders || {},
          rangeChunkSize: 64 * 1024,
          disableAutoFetch: false,
          disableStream: false,
          withCredentials: false,
        };
        loadingTask = pdfjsLib.getDocument(source);
        documentProxy = await loadingTask.promise;
        if (cancelled) {
          await documentProxy?.destroy?.();
          return;
        }

        const totalPages = Number(documentProxy.numPages || 0);
        setPageCount(totalPages);

        for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
          const page = await documentProxy.getPage(pageNumber);
          if (cancelled) {
            return;
          }

          const canvas = canvasRefs.current.get(pageNumber);
          if (!canvas) {
            page.cleanup?.();
            pageNumber -= 1;
            await new Promise((resolve) => window.requestAnimationFrame(resolve));
            continue;
          }

          const baseViewport = page.getViewport({ scale: 1 });
          const cssWidth = Math.max(240, containerWidth);
          const scale = cssWidth / baseViewport.width;
          const viewport = page.getViewport({ scale });
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) {
            throw new Error('PDF canvas could not be prepared.');
          }

          canvas.width = Math.floor(viewport.width * pixelRatio);
          canvas.height = Math.floor(viewport.height * pixelRatio);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

          await page.render({ canvasContext: context, viewport }).promise;
          page.cleanup?.();
          if (!cancelled) {
            setRenderedPages(pageNumber);
          }
        }
      } catch (renderError) {
        if (!cancelled) {
          setError(renderError instanceof Error ? renderError.message : 'PDF could not be rendered.');
        }
      }
    };

    void renderPdf();

    return () => {
      cancelled = true;
      void loadingTask?.destroy?.();
      void documentProxy?.destroy?.();
    };
  }, [containerWidth, requestHeaders, sourceUrl]);

  const isLoading = Boolean(sourceUrl) && !error && (pageCount === 0 || renderedPages < pageCount);

  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-[#dfe8f3]', className)}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#d5dfef] bg-white px-4 py-2 text-xs text-[#607089]">
        <span className="min-w-0 truncate font-semibold text-[#172033]">{title || 'Protected PDF'}</span>
        <span data-testid="course-pdf-page-count" className="shrink-0 rounded-full bg-[#eef4ff] px-3 py-1 font-semibold text-[#2d6ee5]">
          {pageCount > 0 ? `Page ${Math.min(currentPage, pageCount)} / ${pageCount}` : 'Preparing PDF'}
        </span>
      </div>
      <div
        ref={scrollRef}
        data-testid="course-pdf-scroll-container"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-4"
        onContextMenu={(event) => event.preventDefault()}
      >
        {error ? (
          <div className="flex min-h-full items-center justify-center px-4 text-center">
            <div>
              <p className="text-base font-semibold text-[#172033]">PDF could not be rendered</p>
              <p className="mt-2 text-sm leading-6 text-[#607089]">{error}</p>
            </div>
          </div>
        ) : (
          <div data-testid="course-pdf-pages" className="mx-auto flex max-w-full flex-col items-center gap-4">
            {Array.from({ length: pageCount || 1 }, (_, index) => {
              const pageNumber = index + 1;
              return (
                <div
                  key={pageNumber}
                  ref={(element) => {
                    if (element) {
                      pageRefs.current.set(pageNumber, element);
                    } else {
                      pageRefs.current.delete(pageNumber);
                    }
                  }}
                  data-testid="course-pdf-page"
                  data-page-number={pageNumber}
                  className="max-w-full overflow-hidden rounded-sm bg-white shadow-[0_10px_28px_rgba(29,48,83,0.18)]"
                >
                  <canvas
                    ref={(element) => {
                      if (element) {
                        canvasRefs.current.set(pageNumber, element);
                      } else {
                        canvasRefs.current.delete(pageNumber);
                      }
                    }}
                    className="block max-w-full"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {isLoading ? (
        <div className="shrink-0 border-t border-[#d5dfef] bg-white px-4 py-2 text-center text-xs font-semibold text-[#607089]">
          Rendering {renderedPages} / {pageCount || '?'} pages
        </div>
      ) : null}
    </div>
  );
};
