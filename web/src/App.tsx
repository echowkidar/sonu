import * as React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { MotionConfig } from 'motion/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster } from '@/components/ui/sonner';
import { AppShell } from '@/components/shell/AppShell';
import { RequireRole } from '@/components/shell/RequireRole';
import { ThemeProvider } from '@/components/shell/ThemeContext';
import { useSession } from '@/lib/session';
import { ApiError } from '@/lib/api';
import { homeForRole } from '@/nav';

const lazyPage = (f: () => Promise<{ default: React.ComponentType }>) => React.lazy(f);

const Login = lazyPage(() => import('@/pages/public/LoginPage'));
const Setup = lazyPage(() => import('@/pages/public/SetupPage'));
const Forgot = lazyPage(() => import('@/pages/public/ForgotPasswordPage'));
const AcceptInvite = lazyPage(() => import('@/pages/public/TokenPasswordPage').then((m) => ({ default: m.AcceptInvitePage })));
const ResetPassword = lazyPage(() => import('@/pages/public/TokenPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));

const Dashboard = lazyPage(() => import('@/pages/DashboardPage'));
const MyWork = lazyPage(() => import('@/pages/MyWorkPage'));
const WorkRequests = lazyPage(() => import('@/pages/WorkRequestsPage'));
const WorkRequestDetail = lazyPage(() => import('@/pages/WorkRequestDetailPage'));
const MyJobs = lazyPage(() => import('@/pages/MyJobsPage'));
const MyJobDetail = lazyPage(() => import('@/pages/MyJobDetailPage'));
const TeamJobs = lazyPage(() => import('@/pages/TeamJobsPage'));
const ZeroRfeReportPage = lazyPage(() => import('@/pages/ZeroRfeReportPage'));
const Imports = lazyPage(() => import('@/pages/ImportsPage'));
const Notifications = lazyPage(() => import('@/pages/NotificationsPage'));
const Profile = lazyPage(() => import('@/pages/ProfilePage'));
const AdminContractors = lazyPage(() => import('@/pages/admin/AdminContractorsPage'));
const AdminUsers = lazyPage(() => import('@/pages/admin/AdminUsersPage'));
const AdminTeams = lazyPage(() => import('@/pages/admin/AdminTeamsPage'));
const AdminBulkImport = lazyPage(() => import('@/pages/admin/AdminBulkImportPage'));
const AdminEmail = lazyPage(() => import('@/pages/admin/AdminEmailPage'));
const AdminMessaging = lazyPage(() => import('@/pages/admin/AdminMessagingPage'));
const AdminMarafiq = lazyPage(() => import('@/pages/admin/AdminMarafiqPage'));
const AdminRules = lazyPage(() => import('@/pages/admin/AdminRulesPage'));
const AdminLookups = lazyPage(() => import('@/pages/admin/AdminLookupsPage'));
const AdminAudit = lazyPage(() => import('@/pages/admin/AdminAuditPage'));
const DevKit = import.meta.env.DEV ? lazyPage(() => import('@/pages/dev/DevKit')) : null;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

function HomeRedirect() {
  const { user, isLoading } = useSession();
  if (isLoading) return <Skeleton className="m-6 h-8 w-40" />;
  return <Navigate to={user ? homeForRole(user.role) : '/login'} replace />;
}

const Fallback = () => <div className="p-6"><Skeleton className="h-8 w-48" /></div>;

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BrowserRouter>
            <React.Suspense fallback={<Fallback />}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/setup" element={<Setup />} />
                <Route path="/accept-invite" element={<AcceptInvite />} />
                <Route path="/forgot-password" element={<Forgot />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                {DevKit && <Route path="/dev/kit" element={<DevKit />} />}

                <Route element={<RequireRole />}>
                  <Route element={<AppShell />}>
                    <Route index element={<HomeRedirect />} />
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/my-work" element={<MyWork />} />
                    <Route path="/work-requests" element={<WorkRequests />} />
                    <Route path="/work-requests/:code" element={<WorkRequestDetail />} />
                    <Route path="/my-jobs" element={<MyJobs />} />
                    <Route path="/my-jobs/:id" element={<MyJobDetail />} />
                    <Route path="/team-jobs" element={<TeamJobs />} />
                    <Route path="/zero-rfe" element={<ZeroRfeReportPage />} />
                    <Route path="/imports" element={<Imports />} />
                    <Route path="/notifications" element={<Notifications />} />
                    <Route path="/profile" element={<Profile />} />
                    <Route path="/admin/contractors" element={<AdminContractors />} />
                    <Route path="/admin/users" element={<AdminUsers />} />
                    <Route path="/admin/teams" element={<AdminTeams />} />
                    <Route path="/admin/bulk-import" element={<AdminBulkImport />} />
                    <Route path="/admin/email" element={<AdminEmail />} />
                    <Route path="/admin/messaging" element={<AdminMessaging />} />
                    <Route path="/admin/marafiq" element={<AdminMarafiq />} />
                    <Route path="/admin/rules" element={<AdminRules />} />
                    <Route path="/admin/lookups" element={<AdminLookups />} />
                    <Route path="/admin/audit" element={<AdminAudit />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Route>
              </Routes>
            </React.Suspense>
          </BrowserRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}
