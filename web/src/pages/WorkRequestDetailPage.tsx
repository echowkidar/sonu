import { useParams } from 'react-router';
import { PlaceholderPage } from '@/components/PlaceholderPage';

export default function WorkRequestDetailPage() {
  const { code } = useParams<{ code: string }>();
  return <PlaceholderPage title={`Work request ${code ?? ''}`} description="Timeline, files, people, permit, material requests and QF comments for this work request." />;
}
