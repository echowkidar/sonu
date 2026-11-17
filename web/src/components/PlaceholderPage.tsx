import * as React from 'react';
import { PageHeader } from './PageHeader';
import { EmptyState, type Illustration } from './EmptyState';

/** Stand-in for a screen that is built later. Replace the page file's body; keep its default export. */
export function PlaceholderPage({
  title, description, illustration = 'build', children,
}: { title: string; description: string; illustration?: Illustration; children?: React.ReactNode }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState illustration={illustration} title="This screen is not built yet" description={description} />
      {children}
    </>
  );
}
