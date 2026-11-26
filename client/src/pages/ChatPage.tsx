// 助手全屏（/chat/:tid）：同一线程、同一套卡片，适合长对话。
import { useParams } from 'react-router';
import { AssistantPanel } from '../features/assistant/AssistantPanel';
import { s } from '../strings/zh-CN';
import { Page } from '../ui/Page';
import { Group } from '../ui/Surfaces';

export function ChatPage() {
  const { tid = '' } = useParams();
  return (
    <Page back title={s.assistant.title} width="reading">
      <Group>
        <div style={{ height: 'calc(100dvh - 120px)', display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0 }}><AssistantPanel threadOverride={tid} /></div>
        </div>
      </Group>
    </Page>
  );
}
