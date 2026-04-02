import {
  TbBrandGithub,
  TbBrandX,
  TbBrandLinkedin,
  TbMail,
} from "react-icons/tb";

const iconMap: Record<string, React.ComponentType<{ size?: number }>> = {
  github: TbBrandGithub,
  twitter: TbBrandX,
  linkedin: TbBrandLinkedin,
  mail: TbMail,
};

interface Props {
  icon: string;
  size?: number;
}

export default function SocialIcon({ icon, size = 20 }: Props) {
  const Icon = iconMap[icon];
  if (!Icon) return null;
  return <Icon size={size} />;
}
