/**
 * Test user fixtures matching the Prisma schema.
 */

export const ADMIN_USER = {
    id: 1,
    clerkId: 'clerk_test_admin',
    email: 'admin@test.home',
    group: 'admin',
    widgetPreferences: {
        widgetOrder: ['lights', 'alarm', 'temperature', 'weather', 'electricity', 'gas', 'feeder', 'arlo', 'sensors', 'plugs', 'spa'],
    },
    createdAt: new Date('2024-01-01'),
    userGroup: {
        name: 'admin',
        permissions: ['history', 'cameras', 'remote'],
    },
};

export const STANDARD_USER = {
    id: 2,
    clerkId: 'clerk_test_user',
    email: 'user@test.home',
    group: 'user',
    widgetPreferences: {
        widgetOrder: ['lights', 'temperature', 'weather'],
    },
    createdAt: new Date('2024-01-01'),
    userGroup: {
        name: 'user',
        permissions: ['remote'],
    },
};

export const CHILDREN_USER = {
    id: 3,
    clerkId: 'clerk_test_children',
    email: 'child@test.home',
    group: 'children',
    widgetPreferences: {
        widgetOrder: ['weather', 'feeder'],
    },
    createdAt: new Date('2024-01-01'),
    userGroup: {
        name: 'children',
        permissions: [],
    },
};

/** A user without the 'remote' permission (home network only) */
export const LOCAL_ONLY_USER = {
    id: 4,
    clerkId: 'clerk_test_local',
    email: 'local@test.home',
    group: 'user',
    widgetPreferences: {},
    createdAt: new Date('2024-01-01'),
    userGroup: {
        name: 'user',
        permissions: [],
    },
};
