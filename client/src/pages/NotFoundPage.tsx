import { s } from '../strings/zh-CN';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Feedback';
import { Page } from '../ui/Page';

export function NotFoundPage() {
  return (
    <Page title=" " back="/">
      <EmptyState icon="search" title="这个页面不存在" action={<Button variant="primary" to="/">{s.result.backToday}</Button>} />
    </Page>
  );
}
