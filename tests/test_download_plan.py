import unittest
from types import SimpleNamespace
from tools.make_download_plan import BLOCK, archive_phases, member_phase


class DownloadPlanTests(unittest.TestCase):
    def test_semantic_priority(self):
        self.assertEqual(member_phase(b'UI\\Glues\\MainMenu\\main.mdx'),0)
        self.assertEqual(member_phase(b'UI\\Glues\\Multiplayer\\room.fdf'),1)
        self.assertEqual(member_phase(b'Units\\Human\\Footman\\Footman.mdx'),2)
        self.assertEqual(member_phase(b'UI\\Campaign\\Human\\background.blp'),3)
        self.assertEqual(member_phase(b'Sound\\Dialogue\\Human\\intro.wav'),3)

    def test_archive_blocks_include_tables_overlap_and_unclassified_bytes(self):
        names={b'UI\\MainMenu.mdx':1,b'UI\\Multiplayer\\room.fdf':2,b'Units\\unit.mdx':3}
        archive=SimpleNamespace(
            header={'offset':0,'header_size':32,'hash_table_offset':BLOCK*5,
                    'hash_table_entries':3,'block_table_offset':BLOCK*5+128,'block_table_entries':3},
            _archive=SimpleNamespace(_hash=lambda name,kind:names[name]),
            hash_table=[SimpleNamespace(hash_a=i,hash_b=i,block_table_index=i-1) for i in range(1,4)],
            block_table=[SimpleNamespace(offset=BLOCK*2+10,archived_size=20,flags=0x80000000),
                         SimpleNamespace(offset=BLOCK+10,archived_size=BLOCK+100,flags=0x80000000),
                         SimpleNamespace(offset=BLOCK*3,archived_size=BLOCK,flags=0x80000000)])
        result=archive_phases(archive,6*BLOCK,names)
        self.assertEqual(result,{'menu':[[0,0],[2,2],[5,5]],'multiplayer':[[1,1]],'match':[[3,3]],'campaign':[[4,4]]})


if __name__=='__main__':unittest.main()
