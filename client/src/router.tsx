// 路由：一个页面文件 = 一个 NavDestination（08 第 1.3 节）。路径见 02 第 4.1 节。
import { createBrowserRouter } from 'react-router';
import { AppShell } from './features/shell/AppShell';
import { AuthGuard, RootLayout } from './features/shell/RootLayout';
import { ChatPage } from './pages/ChatPage';
import { CourseHomePage } from './pages/CourseHomePage';
import { CoursesPage } from './pages/CoursesPage';
import { FocusPage } from './pages/FocusPage';
import { InsightPage } from './pages/InsightPage';
import { KpPage } from './pages/KpPage';
import { LoginPage } from './pages/LoginPage';
import { MaterialsPage } from './pages/MaterialsPage';
import { AboutPage, AccountPage, AppearancePage, AssistantSettingsPage, DataPage, FeedbackPage, IntensityPage, RemindersPage } from './pages/me/SettingsPages';
import { AiModelsPage, UsagePage } from './pages/me/AiPages';
import { MePage } from './pages/me/MePage';
import { PluginDetailPage, PluginsPage } from './pages/me/PluginPages';
import { MistakesPage } from './pages/MistakesPage';
import { NewCoursePage } from './pages/NewCoursePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { PageViewerPage } from './pages/PageViewerPage';
import { PracticePage } from './pages/PracticePage';
import { ResultPage } from './pages/ResultPage';
import { SchedulePage } from './pages/SchedulePage';
import { SessionPage } from './pages/SessionPage';
import { TodayPage } from './pages/TodayPage';
import { WelcomePage } from './pages/WelcomePage';

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/welcome', element: <WelcomePage /> },
      { path: '/login', element: <LoginPage /> },
      {
        element: <AuthGuard />,
        children: [
          { path: '/onboarding', element: <OnboardingPage /> },
          { path: '/courses/new', element: <NewCoursePage /> },
          { path: '/session/:sid', element: <SessionPage /> },
          {
            element: <AppShell />,
            children: [
              { path: '/', element: <TodayPage /> },
              { path: '/courses', element: <CoursesPage /> },
              { path: '/c/:cid', element: <CourseHomePage /> },
              { path: '/c/:cid/kp/:kid', element: <KpPage /> },
              { path: '/c/:cid/materials', element: <MaterialsPage /> },
              { path: '/c/:cid/focus', element: <FocusPage /> },
              { path: '/c/:cid/practice', element: <PracticePage /> },
              { path: '/c/:cid/insight', element: <InsightPage /> },
              { path: '/m/:mid/p/:page', element: <PageViewerPage /> },
              { path: '/schedule', element: <SchedulePage /> },
              { path: '/practice', element: <PracticePage /> },
              { path: '/practice/mistakes', element: <MistakesPage /> },
              { path: '/session/:sid/result', element: <ResultPage /> },
              { path: '/chat/:tid', element: <ChatPage /> },
              { path: '/notifications', element: <NotificationsPage /> },
              { path: '/me', element: <MePage /> },
              { path: '/me/ai', element: <AiModelsPage /> },
              { path: '/me/ai/usage', element: <UsagePage /> },
              { path: '/me/plugins', element: <PluginsPage /> },
              { path: '/me/plugins/:pid', element: <PluginDetailPage /> },
              { path: '/me/reminders', element: <RemindersPage /> },
              { path: '/me/intensity', element: <IntensityPage /> },
              { path: '/me/appearance', element: <AppearancePage /> },
              { path: '/me/assistant', element: <AssistantSettingsPage /> },
              { path: '/me/account', element: <AccountPage /> },
              { path: '/me/data', element: <DataPage /> },
              { path: '/me/about', element: <AboutPage /> },
              { path: '/me/feedback', element: <FeedbackPage /> },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
]);
