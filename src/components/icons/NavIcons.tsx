import {
  TbCode,
  TbNotebook,
  TbFileText,
  TbArrowUp,
  TbChevronLeft,
  TbSearch,
  TbCalendar,
  TbArrowRight,
  TbBriefcase,
  TbMapPin,
  TbClock,
  TbHash,
  TbCommand,
  TbCopy,
  TbCheck,
  TbList,
  TbTag,
} from "react-icons/tb";

export function ProjectsIcon({ size = 18 }: { size?: number }) {
  return <TbCode size={size} />;
}

export function BlogIcon({ size = 18 }: { size?: number }) {
  return <TbNotebook size={size} />;
}

export function ResumeIcon({ size = 18 }: { size?: number }) {
  return <TbFileText size={size} />;
}

export function ArrowUpIcon({ size = 16 }: { size?: number }) {
  return <TbArrowUp size={size} />;
}

export function BackIcon({ size = 16 }: { size?: number }) {
  return <TbChevronLeft size={size} />;
}

export function SearchIcon({ size = 16 }: { size?: number }) {
  return <TbSearch size={size} />;
}

export function CalendarIcon({ size = 14 }: { size?: number }) {
  return <TbCalendar size={size} />;
}

export function ArrowRightIcon({ size = 16 }: { size?: number }) {
  return <TbArrowRight size={size} />;
}

export function BriefcaseIcon({ size = 16 }: { size?: number }) {
  return <TbBriefcase size={size} />;
}

export function LocationIcon({ size = 14 }: { size?: number }) {
  return <TbMapPin size={size} />;
}

export function TimerIcon({ size = 14 }: { size?: number }) {
  return <TbClock size={size} />;
}

export function HashIcon({ size = 14 }: { size?: number }) {
  return <TbHash size={size} />;
}

export function CommandIcon({ size = 16 }: { size?: number }) {
  return <TbCommand size={size} />;
}

export function CopyIcon({ size = 16 }: { size?: number }) {
  return <TbCopy size={size} />;
}

export function CheckIcon({ size = 16 }: { size?: number }) {
  return <TbCheck size={size} />;
}

export function TocIcon({ size = 16 }: { size?: number }) {
  return <TbList size={size} />;
}

export function TagIcon({ size = 14 }: { size?: number }) {
  return <TbTag size={size} />;
}
