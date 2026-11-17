import { useParams } from 'react-router';
import { PlaceholderPage } from '@/components/PlaceholderPage';

export default function MyJobDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <PlaceholderPage title={`Job ${id ?? ''}`} description="Location, description, permit state, photos and the big Start / Update / Done button." />;
}
