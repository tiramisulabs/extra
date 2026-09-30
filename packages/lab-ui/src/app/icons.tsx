import type { ReactNode } from 'react';

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false">
			{children}
		</svg>
	);
}

export const HashIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M5 9h14M4 15h14M10 3 8 21M16 3l-2 18" />
	</Icon>
);
export const LockedHashIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M4 9h9M3 15h8M9 3 7 21M15 3l-1 7" />
		<rect x="14" y="14" width="8" height="7" rx="1.5" />
		<path d="M16 14v-2a2 2 0 0 1 4 0v2" />
	</Icon>
);
export const MembersIcon = () => (
	<Icon>
		<circle cx="9" cy="8" r="3.5" />
		<path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
		<path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 20a6.5 6.5 0 0 0-3-5.5" />
	</Icon>
);
export const FlaskIcon = ({ size }: { size?: number }) => (
	<Icon size={size}>
		<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />
		<path d="M7.5 15h9" />
	</Icon>
);
export const MenuIcon = () => (
	<Icon>
		<path d="M4 6h16M4 12h16M4 18h16" />
	</Icon>
);
export const CloseIcon = ({ size = 18 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M6 6l12 12M18 6 6 18" />
	</Icon>
);
export const SendIcon = () => (
	<Icon>
		<path d="M4 12 20 4l-4 16-4-7z" />
		<path d="m12 13 8-9" />
	</Icon>
);
export const PinIcon = ({ size = 16 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M9 4h6l-1 6 3 3H7l3-3z" />
		<path d="M12 13v7" />
	</Icon>
);
export const EyeIcon = ({ size = 14 }: { size?: number }) => (
	<Icon size={size}>
		<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
		<circle cx="12" cy="12" r="3" />
	</Icon>
);
export const SlashIcon = () => (
	<Icon>
		<rect x="3" y="3" width="18" height="18" rx="5" />
		<path d="m14.5 7-5 10" />
	</Icon>
);
export const ChevronIcon = ({ size = 14 }: { size?: number }) => (
	<Icon size={size}>
		<path d="m6 9 6 6 6-6" />
	</Icon>
);
