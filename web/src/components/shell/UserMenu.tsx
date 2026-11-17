import { LogOut, UserCircle, Languages } from 'lucide-react';
import { Link } from 'react-router';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useLogout, type SessionUser } from '@/lib/session';
import { ROLE_LABELS } from '@/lib/roles';
import { useThemeContext } from './ThemeContext';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

export function UserMenu({ user }: { user: SessionUser }) {
  const logout = useLogout();
  const { dir, setDir } = useThemeContext();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Account menu" className="tap inline-flex items-center justify-center rounded-full">
          <Avatar><AvatarFallback>{initials(user.fullName)}</AvatarFallback></Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          <span className="block text-sm font-semibold text-foreground">{user.fullName}</span>
          <span className="block font-normal">{ROLE_LABELS[user.role]}{user.contractorName ? ` · ${user.contractorName}` : ''}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link to="/profile"><UserCircle /> Profile</Link></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setDir(dir === 'rtl' ? 'ltr' : 'rtl')}><Languages /> {dir === 'rtl' ? 'Left-to-right layout' : 'Right-to-left layout'}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()}><LogOut /> Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
