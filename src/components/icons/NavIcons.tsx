import {
  TbChevronLeft,
  TbSearch,
  TbCalendar,
  TbClock,
  TbTag,
} from "react-icons/tb";

export function BackIcon({ size = 16 }: { size?: number }) {
  return <TbChevronLeft size={size} />;
}

export function SearchIcon({ size = 16 }: { size?: number }) {
  return <TbSearch size={size} />;
}

export function CalendarIcon({ size = 14 }: { size?: number }) {
  return <TbCalendar size={size} />;
}

export function TimerIcon({ size = 14 }: { size?: number }) {
  return <TbClock size={size} />;
}

export function TagIcon({ size = 14 }: { size?: number }) {
  return <TbTag size={size} />;
}
