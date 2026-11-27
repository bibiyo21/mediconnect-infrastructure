<?php

// Tinker script for reverb-walkin-smoke.sh (LOCAL only). Creates SYNTHETIC accounts on the development
// database. Every email carries the run tag, so the rows are easy to find and remove later.
// Reads SMOKE_PASSWORD and SMOKE_TAG from the environment. Prints one line: SMOKE_IDS={json}, ids only.

use App\Modules\Doctors\Models\DoctorProfile;
use App\Modules\Patients\Models\PatientProfile;
use App\Modules\Rbac\Contracts\AssignsRoles;
use App\Modules\Rbac\Enums\Role;
use App\Modules\Users\Contracts\Accounts;
use App\Shared\Services\Fingerprint;
use Illuminate\Support\Facades\DB;

$password = getenv('SMOKE_PASSWORD');
$tag = getenv('SMOKE_TAG');
if (! $password || ! $tag) {
    fwrite(STDERR, "SMOKE_PASSWORD and SMOKE_TAG are required.\n");
    exit(2);
}

$account = function (string $key, array $roles, string $first, bool $mobile) use ($password, $tag) {
    $email = "walkin-smoke-{$key}-{$tag}@example.test";
    $user = app(Accounts::class)->register($email, null, $password, ['first_name' => $first, 'last_name' => 'Smoke']);
    foreach ($roles as $role) {
        app(AssignsRoles::class)->assign($user, $role);
    }
    if ($mobile) {
        DB::table('users')->where('id', $user->id)->update(['mobile_e164' => '+639'.random_int(100000000, 999999999), 'mobile_verified_at' => now()]);
    }

    return $user->refresh();
};

$patientProfile = function ($user, string $first) {
    return PatientProfile::factory()->create([
        'user_id' => $user->id, 'first_name' => $first, 'last_name' => 'Smoke', 'date_of_birth' => '1990-05-01',
    ]);
};

$p1 = $account('p1', [Role::Patient], 'Patient1', true);
$p2 = $account('p2', [Role::Patient], 'Patient2', true);
$g = $account('guardian', [Role::Patient], 'Guardian', true);
$doc = $account('doctor', [Role::Doctor], 'Doctor', false);
$mgr = $account('manager', [Role::ClinicManager], 'Manager', false);
$admin = $account('admin', [Role::Admin], 'Admin', false);

$profiles = [
    'p1' => $patientProfile($p1, 'Patient1')->id,
    'p2' => $patientProfile($p2, 'Patient2')->id,
    'guardian' => $patientProfile($g, 'Guardian')->id,
];

$licence = (string) random_int(1000000, 9999999);
$doctor = new DoctorProfile(['display_name' => "Dr. Smoke {$tag}"]);
$doctor->user_id = $doc->id;
$doctor->prc_license_number_encrypted = $licence;
$doctor->prc_license_number_hash = Fingerprint::of('prc:'.$licence);
$doctor->save();
DB::table('doctor_profiles')->where('id', $doctor->id)->update([
    'onboarding_status' => 'ACTIVE', 'license_verification_status' => 'VERIFIED', 'verified_at' => now(),
]);

echo 'SMOKE_IDS='.json_encode([
    'tag' => $tag,
    'users' => ['p1' => $p1->id, 'p2' => $p2->id, 'guardian' => $g->id, 'doctor' => $doc->id, 'manager' => $mgr->id, 'admin' => $admin->id],
    'emails' => ['p1' => $p1->email, 'p2' => $p2->email, 'guardian' => $g->email, 'doctor' => $doc->email, 'manager' => $mgr->email, 'admin' => $admin->email],
    'profiles' => $profiles,
    'doctor_profile' => $doctor->id,
    'licence' => $licence,
])."\n";
