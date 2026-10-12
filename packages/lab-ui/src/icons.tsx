import type { ReactNode } from 'react';

function Icon({ children, size = 20, filled = false }: { children: ReactNode; size?: number; filled?: boolean }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill={filled ? 'currentColor' : 'none'}
			stroke={filled ? 'none' : 'currentColor'}
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
	<Icon size={size} filled>
		<path
			fillRule="evenodd"
			d="M10.99 3.16A1 1 0 1 0 9 2.84L8.15 8H4a1 1 0 0 0 0 2h3.82l-.67 4H3a1 1 0 1 0 0 2h3.82l-.8 4.84a1 1 0 0 0 1.97.32L8.85 16h4.97l-.8 4.84a1 1 0 0 0 1.97.32l.86-5.16H20a1 1 0 1 0 0-2h-3.82l.67-4H21a1 1 0 1 0 0-2h-3.82l.8-4.84a1 1 0 1 0-1.97-.32L15.15 8h-4.97l.8-4.84ZM14.15 14l.67-4H9.85l-.67 4h4.97Z"
		/>
	</Icon>
);
export const LockedHashIcon = ({ size }: { size?: number }) => (
	<Icon size={size} filled>
		<path
			fillRule="evenodd"
			d="M16 4h.5v-.5a2.5 2.5 0 0 1 5 0V4h.5a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm4-.5V4h-2v-.5a1 1 0 1 1 2 0Z"
		/>
		<path d="M12.5 8c.28 0 .5.22.5.5V9c0 .1 0 .2.02.31.03.34-.21.69-.56.69H9.85l-.67 4h4.97l.28-1.68c.06-.34.44-.52.77-.43a3 3 0 0 0 .8.11c.27 0 .47.24.43.5l-.25 1.5H20a1 1 0 1 1 0 2h-4.15l-.86 5.16a1 1 0 0 1-1.98-.32l.8-4.84H8.86l-.86 5.16A1 1 0 0 1 6 20.84L6.82 16H3a1 1 0 1 1 0-2h4.15l.67-4H4a1 1 0 1 1 0-2h4.15l.86-5.16a1 1 0 1 1 1.98.32L10.19 8h2.31Z" />
	</Icon>
);
export const MembersIcon = () => (
	<Icon filled>
		<path d="M14.5 8a3 3 0 1 0-2.7-4.3c-.2.4.06.86.44 1.12a5 5 0 0 1 2.14 3.08c.01.06.06.1.12.1ZM18.44 17.27c.15.43.54.73 1 .73h1.06c.83 0 1.5-.67 1.5-1.5a7.5 7.5 0 0 0-6.5-7.43c-.55-.08-.99.38-1.1.92-.06.3-.15.6-.26.87-.23.58-.05 1.3.47 1.63a9.53 9.53 0 0 1 3.83 4.78ZM12.5 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM2 20.5a7.5 7.5 0 0 1 15 0c0 .83-.67 1.5-1.5 1.5a.2.2 0 0 1-.2-.16c-.2-.96-.56-1.87-.88-2.54-.1-.23-.42-.15-.42.1v2.1a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-2.1c0-.25-.31-.33-.42-.1-.32.67-.67 1.58-.88 2.54a.2.2 0 0 1-.2.16A1.5 1.5 0 0 1 2 20.5Z" />
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
export const ExternalLinkIcon = () => (
	<Icon size={16}>
		<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
	</Icon>
);

export const UploadIcon = () => (
	<Icon>
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
		<path d="M14 2v6h6M12 18v-7m-3 3 3-3 3 3" />
	</Icon>
);
