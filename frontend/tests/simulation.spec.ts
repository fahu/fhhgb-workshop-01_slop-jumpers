import { test, expect } from '@playwright/test';
import { RobotSimulation } from '../src/game/simulation';
import { slopItems } from '../src/game/slop-items';
import type { Level } from '../src/types';

function level(overrides: Partial<Level> = {}): Level {
  return { number: 1, courseVersion: 'slop-v1', start: 0, end: 1500, obstacles: [], stars: [], ...overrides };
}

test('first collision kills the robot and further frames cannot move it', () => {
  const robot = new RobotSimulation(level({ obstacles: [{ distance: 180, width: 4, height: 27, slopId: 'seven-finger-hand' }] }));
  robot.advance(4000);
  expect(robot.dead).toBe(true);
  expect(robot.progress().collisionId).toBe('seven-finger-hand');
  expect(robot.distance).toBeGreaterThan(175);
  expect(robot.distance).toBeLessThan(180);
  const distance = robot.distance;
  robot.advance(1000);
  expect(robot.distance).toBe(distance);
});

test('jumps clear all authored obstacles at starting and maximum speed', () => {
  const obstacles = [180, 285, 395, 505, 615, 725, 835, 945, 1055, 1165, 1275, 1385].map((distance, i) => ({ distance, width: 4 + i % 3, height: 27 + i % 3 * 6, slopId: slopItems[i].id }));
  for (const elapsed of [0, 100000]) {
    const robot = new RobotSimulation(level({ obstacles }));
    robot.elapsedMs = elapsed;
    robot.advance(30000, true);
    expect(robot.dead).toBe(false);
    expect(robot.progress().collisionId).toBeUndefined();
    expect(robot.levelComplete).toBe(true);
    expect(robot.distance).toBe(1500);
  }
});

test('high tokens require a jump and jumping misses floor tokens', () => {
  const stars = [{ id: 0, distance: 14, height: 106 }, { id: 1, distance: 14, height: 14 }];
  const grounded = new RobotSimulation(level({ stars }));
  grounded.advance(500);
  expect([...grounded.collected]).toEqual([1]);
  const jumping = new RobotSimulation(level({ stars }));
  jumping.jump();
  jumping.advance(500);
  expect([...jumping.collected]).toEqual([0]);
});

test('speed increases with active time and is capped; level gates prevent running into unloaded geometry', () => {
  const robot = new RobotSimulation(level());
  robot.advance(30000);
  expect(robot.distance).toBe(1500);
  expect(robot.speed).toBeGreaterThan(60);
  const elapsed = robot.elapsedMs;
  robot.advance(10000);
  expect(robot.elapsedMs).toBe(elapsed);
  expect(() => robot.loadLevel(level({ number: 3, start: 3000, end: 4500 }))).toThrow();
  robot.loadLevel(level({ number: 2, start: 1500, end: 3000 }));
  robot.advance(100);
  expect(robot.distance).toBeGreaterThan(1500);
  robot.elapsedMs = 200000;
  expect(robot.speed).toBe(130);
});

test('autoplay jumps earlier obstacles and collides when it skips the selected jump', () => {
  const obstacles = [7680, 7785, 7895, 8005].map((distance, i) => ({
    distance, width: 4 + i % 3, height: 27 + i % 3 * 6, slopId: slopItems[i].id,
  }));
  const robot = new RobotSimulation(level({ number: 6, start: 7500, end: 9000, obstacles }));
  robot.elapsedMs = 100000;
  robot.advance(10000, true, obstacles[2]);
  expect(robot.progress().collisionId).toBe(obstacles[2].slopId);
  expect(robot.distance).toBeGreaterThan(7890);
  expect(robot.distance).toBeLessThan(7895);
});
