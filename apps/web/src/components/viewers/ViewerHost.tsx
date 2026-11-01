import React, { lazy, Suspense } from 'react';
import type { DetectedFile, TabViewerState } from '@omniview/shared-types';
import type { ViewerDocument } from '@omniview/viewer-core';
import type {
  ArchiveViewerPayload,
  CodeViewerPayload,
  EbookViewerPayload,
  FallbackViewerPayload,
  ImageViewerPayload,
  MediaViewerPayload,
  PresentationViewerPayload,
  SpreadsheetViewerPayload,
  WordViewerPayload,
} from '@omniview/viewer-adapters';
// Each viewer (and its parser: pdf.js, SheetJS, ...) loads on first use.
const PDFViewer = lazy(() => import('./PDFViewer').then((m) => ({ default: m.PDFViewer })));
const WordViewer = lazy(() => import('./WordViewer').then((m) => ({ default: m.WordViewer })));
const PresentationViewer = lazy(() => import('./PresentationViewer').then((m) => ({ default: m.PresentationViewer })));
const SpreadsheetViewer = lazy(() => import('./SpreadsheetViewer').then((m) => ({ default: m.SpreadsheetViewer })));
const otherViewers = () => import('./OtherViewers');
const ArchiveViewer = lazy(() => otherViewers().then((m) => ({ default: m.ArchiveViewer })));
const CodeViewer = lazy(() => otherViewers().then((m) => ({ default: m.CodeViewer })));
const EbookViewer = lazy(() => otherViewers().then((m) => ({ default: m.EbookViewer })));
const FallbackViewer = lazy(() => otherViewers().then((m) => ({ default: m.FallbackViewer })));
const ImageViewer = lazy(() => otherViewers().then((m) => ({ default: m.ImageViewer })));
const MediaViewer = lazy(() => otherViewers().then((m) => ({ default: m.MediaViewer })));

function ViewerLoading() {
  return (
    <div className="flex-1 h-full flex items-center justify-center">
      <span className="px-spinner" role="status" aria-label="Loading viewer">
        <i /><i /><i /><i /><i /><i /><i /><i /><i />
      </span>
    </div>
  );
}

interface ViewerHostProps {
  file: DetectedFile;
  tab: TabViewerState;
  buffer?: ArrayBuffer;
  document?: ViewerDocument;
}

export const ViewerHost: React.FC<ViewerHostProps> = ({
  file,
  tab,
  buffer,
  document,
}) => {
  if (!buffer || !document) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-slate-400">
        Loading document stream...
      </div>
    );
  }

  const viewer = (() => {
  switch (tab.adapterId) {
    case 'PDFViewerAdapter':
      return <PDFViewer file={file} tab={tab} buffer={buffer} />;

    case 'WordViewerAdapter':
      return (
        <WordViewer
          file={file}
          tab={tab}
          document={document as ViewerDocument<WordViewerPayload>}
        />
      );

    case 'PresentationViewerAdapter':
      return (
        <PresentationViewer
          file={file}
          tab={tab}
          document={document as ViewerDocument<PresentationViewerPayload>}
        />
      );

    case 'SpreadsheetViewerAdapter':
      return (
        <SpreadsheetViewer
          file={file}
          tab={tab}
          document={document as ViewerDocument<SpreadsheetViewerPayload>}
        />
      );

    case 'ImageViewerAdapter':
      return (
        <ImageViewer
          file={file}
          tab={tab}
          document={document as ViewerDocument<ImageViewerPayload>}
        />
      );

    case 'EbookViewerAdapter':
      return (
        <EbookViewer
          file={file}
          tab={tab}
          document={document as ViewerDocument<EbookViewerPayload>}
        />
      );

    case 'CodeViewerAdapter':
      return (
        <CodeViewer
          file={file}
          tab={tab}
          document={document as ViewerDocument<CodeViewerPayload>}
        />
      );

    case 'AudioViewerAdapter':
    case 'VideoViewerAdapter':
      return (
        <MediaViewer
          file={file}
          document={document as ViewerDocument<MediaViewerPayload>}
        />
      );

    case 'ArchiveViewerAdapter':
      return (
        <ArchiveViewer
          file={file}
          tab={tab}
          document={document as ViewerDocument<ArchiveViewerPayload>}
        />
      );

    case 'FallbackViewerAdapter':
    default:
      return (
        <FallbackViewer
          file={file}
          document={document as ViewerDocument<FallbackViewerPayload>}
        />
      );
  }
  })();

  return <Suspense fallback={<ViewerLoading />}>{viewer}</Suspense>;
};
