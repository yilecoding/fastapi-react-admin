import { cn } from '@/lib/utils';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import * as React from 'react';

const duration = 1000;

function Skeleton({
  className,
  ...props
}: React.ComponentProps<typeof View> & React.RefAttributes<View>) {
  const sv = useSharedValue(1);

  React.useEffect(() => {
    sv.value = withRepeat(withTiming(0.5, { duration }), -1, true);
    // `sv` 是 reanimated 的 shared value —— 引用恒定，补进依赖不会让 effect 重跑，
    // 但少了它 `react-hooks/exhaustive-deps` 会警告（下面的 useAnimatedStyle
    // 已经把它列进依赖了，两处不一致更容易让人以为哪一处写错了）
  }, [sv]);

  const style = useAnimatedStyle(
    () => ({
      opacity: sv.value,
    }),
    [sv]
  );
  return (
    <Animated.View
      style={style}
      className={cn('bg-secondary dark:bg-muted rounded-md', className)}
      {...props}
    />
  );
}

export { Skeleton };
